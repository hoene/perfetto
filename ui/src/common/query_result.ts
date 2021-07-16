// Copyright (C) 2021 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// This file deals with deserialization and iteration of the proto-encoded
// byte buffer that is returned by TraceProcessor when invoking the
// TPM_QUERY_STREAMING method. The returned |query_result| buffer is optimized
// for being moved cheaply across workers and decoded on-the-flight as we step
// through the iterator.
// See comments around QueryResult in trace_processor.proto for more details.

// The classes in this file are organized as follows:
//
// QueryResultImpl:
// The object returned by the Engine.queryV2(sql) method.
// This object is a holder of row data. Batches of raw get appended
// incrementally as they are received by the remote TraceProcessor instance.
// QueryResultImpl also deals with asynchronicity of queries and allows callers
// to obtain a promise that waits for more (or all) rows.
// At any point in time the following objects hold a reference to QueryResult:
// - The Engine: for appending row batches.
// - UI code, typically controllers, who make queries.
//
// ResultBatch:
// Hold the data, returned by the remote TraceProcessor instance, for a number
// of rows (TP typically chunks the results in batches of 128KB).
// A QueryResultImpl holds exclusively ResultBatches for a given query.
// ResultBatch is not exposed externally, it's just an internal representation
// that helps with proto decoding. ResultBatch is immutable after it gets
// appended and decoded. The iteration state is held by the RowIteratorImpl.
//
// RowIteratorImpl:
// Decouples the data owned by QueryResultImpl (and its ResultBatch(es)) from
// the iteration state. The iterator effectively is the union of a ResultBatch
// and the row number in it. Rows within the batch are decoded as the user calls
// next(). When getting at the end of the batch, it takes care of switching to
// the next batch (if any) within the QueryResultImpl.
// This object is part of the API exposed to tracks / controllers.

import * as protobuf from 'protobufjs/minimal';

import {defer, Deferred} from '../base/deferred';
import {assertExists, assertFalse, assertTrue} from '../base/logging';
import {utf8Decode} from '../base/string_utils';

export const NUM = 0;
export const STR = 'str';
export const NUM_NULL: number|null = 1;
export const STR_NULL: string|null = 'str_null';

export type ColumnType = string|number|null;

// One row extracted from an SQL result:
export interface Row {
  [key: string]: ColumnType;
}

// The methods that any iterator has to implement.
export interface RowIteratorBase {
  valid(): boolean;
  next(): void;

  // Reflection support for cases where the column names are not known upfront
  // (e.g. the query result table for user-provided SQL queries).
  // It throws if the passed column name doesn't exist.
  // Example usage:
  // for (const it = queryResult.iter({}); it.valid(); it.next()) {
  //   for (const columnName : queryResult.columns()) {
  //      console.log(it.get(columnName));
  get(columnName: string): ColumnType;
}

// A RowIterator is a type that has all the fields defined in the query spec
// plus the valid() and next() operators. This is to ultimately allow the
// clients to do:
// const result = await engine.queryV2("select name, surname, id from people;");
// const iter = queryResult.iter({name: STR, surname: STR, id: NUM});
// for (; iter.valid(); iter.next())
//  console.log(iter.name, iter.surname);
export type RowIterator<T extends Row> = RowIteratorBase&T;

function columnTypeToString(t: ColumnType): string {
  switch (t) {
    case NUM:
      return 'NUM';
    case NUM_NULL:
      return 'NUM_NULL';
    case STR:
      return 'STR';
    case STR_NULL:
      return 'STR_NULL';
    default:
      return `INVALID(${t})`;
  }
}

// Disable Long.js support in protobuf. This seems to be enabled only in tests
// but not in production code. In any case, for now we want casting to number
// accepting the 2**53 limitation. This is consistent with passing
// --force-number in the protobuf.js codegen invocation in //ui/BUILD.gn .
// See also https://github.com/protobufjs/protobuf.js/issues/1253 .
(protobuf.util as {} as {Long: undefined}).Long = undefined;
protobuf.configure();

// This has to match CellType in trace_processor.proto.
enum CellType {
  CELL_NULL = 1,
  CELL_VARINT = 2,
  CELL_FLOAT64 = 3,
  CELL_STRING = 4,
  CELL_BLOB = 5,
}

const CELL_TYPE_NAMES =
    ['UNKNOWN', 'NULL', 'VARINT', 'FLOAT64', 'STRING', 'BLOB'];

const TAG_LEN_DELIM = 2;

// This is the interface exposed to readers (e.g. tracks). The underlying object
// (QueryResultImpl) owns the result data. This allows to obtain iterators on
// that. In future it will allow to wait for incremental updates (new rows being
// fetched) for streaming queries.
export interface QueryResult {
  // Obtains an iterator.
  // TODO(primiano): this should have an option to destruct data as we read. In
  // the case of a long query (e.g. `SELECT * FROM sched` in the query prompt)
  // we don't want to accumulate everything in memory. OTOH UI tracks want to
  // keep the data around so they can redraw them on each animation frame. For
  // now we keep everything in memory in the QueryResultImpl object.
  // iter<T extends Row>(spec: T): RowIterator<T>;
  iter<T extends Row>(spec: T): RowIterator<T>;

  // Like iter() for queries that expect only one row. It embeds the valid()
  // check (i.e. throws if no rows are available) and returns directly the
  // first result.
  firstRow<T extends Row>(spec: T): T;

  // If != undefined the query errored out and error() contains the message.
  error(): string|undefined;

  // Returns the number of rows accumulated so far. Note that this number can
  // change over time as more batches are received. It becomes stable only
  // when isComplete() returns true or after waitAllRows() is resolved.
  numRows(): number;

  // If true all rows have been fetched. Calling iter() will iterate through the
  // last row. If false, iter() will return an iterator which might iterate
  // through some rows (or none) but will surely not reach the end.

  isComplete(): boolean;

  // Returns a promise that is resolved only when all rows (i.e. all batches)
  // have been fetched. The promise return value is always the object iself.
  waitAllRows(): Promise<QueryResult>;

  // Can return an empty array if called before the first batch is resolved.
  // This should be called only after having awaited for at least one batch.
  columns(): string[];

  // TODO(primiano): next CLs will introduce a waitMoreRows() to allow tracks
  // to await until some more data (but not necessarily all) is available. For
  // now everything uses waitAllRows().
}

// Interface exposed to engine.ts to pump in the data as new row batches arrive.
export interface WritableQueryResult extends QueryResult {
  // |resBytes| is a proto-encoded trace_processor.QueryResult message.
  //  The overall flow looks as follows:
  // - The user calls engine.queryV2('select ...') and gets a QueryResult back.
  // - The query call posts a message to the worker that runs the SQL engine (
  //   or sends a HTTP request in case of the RPC+HTTP interface).
  // - The returned QueryResult object is initially empty.
  // - Over time, the sql engine will postMessage() back results in batches.
  // - Each bach will end up calling this appendResultBatch() method.
  // - If there is any pending promise (e.g. the caller called
  //   queryResult.waitAllRows()), this call will awake them (if this is the
  //   last batch).
  appendResultBatch(resBytes: Uint8Array): void;
}

// The actual implementation, which bridges together the reader side and the
// writer side (the one exposed to the Engine). This is the same object so that
// when the engine pumps new row batches we can resolve pending promises that
// readers (e.g. track code) are waiting for.
class QueryResultImpl implements QueryResult, WritableQueryResult {
  columnNames: string[] = [];
  private _error?: string;
  private _numRows = 0;
  private _isComplete = false;

  // --- QueryResult implementation.

  // TODO(primiano): for the moment new batches are appended but old batches
  // are never removed. This won't work with abnormally large result sets, as
  // it will stash all rows in memory. We could switch to a model where the
  // iterator is destructive and deletes batch objects once iterating past the
  // end of each batch. If we do that, than we need to assign monotonic IDs to
  // batches. Also if we do that, we should prevent creating more than one
  // iterator for a QueryResult.
  batches: ResultBatch[] = [];

  // Promise awaiting on waitAllRows(). This should be resolved only when the
  // last result batch has been been retrieved.
  private allRowsPromise?: Deferred<QueryResult>;

  isComplete(): boolean {
    return this._isComplete;
  }
  numRows(): number {
    return this._numRows;
  }
  error(): string|undefined {
    return this._error;
  }
  columns(): string[] {
    return this.columnNames;
  }

  iter<T extends Row>(spec: T): RowIterator<T> {
    const impl = new RowIteratorImplWithRowData(spec, this);
    return impl as {} as RowIterator<T>;
  }

  firstRow<T extends Row>(spec: T): T {
    const impl = new RowIteratorImplWithRowData(spec, this);
    assertTrue(impl.valid());
    return impl as {} as RowIterator<T>as T;
  }

  // Can be called only once.
  waitAllRows(): Promise<QueryResult> {
    assertTrue(this.allRowsPromise === undefined);
    this.allRowsPromise = defer<QueryResult>();
    if (this._isComplete) {
      this.resolveOrReject(this.allRowsPromise, this);
    }
    return this.allRowsPromise;
  }

  // --- WritableQueryResult implementation.

  // Called by the engine when a new QueryResult is available. Note that a
  // single Query() call can yield >1 QueryResult due to result batching
  // if more than ~64K of data are returned, e.g. when returning O(M) rows.
  // |resBytes| is a proto-encoded trace_processor.QueryResult message.
  // It is fine to retain the resBytes without slicing a copy, because
  // ProtoRingBuffer does the slice() for us (or passes through the buffer
  // coming from postMessage() (Wasm case) of fetch() (HTTP+RPC case).
  appendResultBatch(resBytes: Uint8Array) {
    const reader = protobuf.Reader.create(resBytes);
    assertTrue(reader.pos === 0);
    const columnNamesEmptyAtStartOfBatch = this.columnNames.length === 0;
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:  // column_names
          // Only the first batch should contain the column names. If this fires
          // something is going wrong in the handling of the batch stream.
          assertTrue(columnNamesEmptyAtStartOfBatch);
          this.columnNames.push(reader.string());
          break;
        case 2:  // error
          // The query has errored only if the |error| field is non-empty.
          // In protos, we don't distinguish between non-present and empty.
          // Make sure we don't propagate ambiguous empty strings to JS.
          const err = reader.string();
          this._error = (err !== undefined && err.length) ? err : undefined;
          break;
        case 3:  // batch
          const batchLen = reader.uint32();
          const batchRaw = resBytes.subarray(reader.pos, reader.pos + batchLen);
          reader.pos += batchLen;

          // The ResultBatch ctor parses the CellsBatch submessage.
          const parsedBatch = new ResultBatch(batchRaw);
          this.batches.push(parsedBatch);
          this._isComplete = parsedBatch.isLastBatch;

          // In theory one could construct a valid proto serializing the column
          // names after the cell batches. In practice the QueryResultSerializer
          // doesn't do that so it's not worth complicating the code.
          const numColumns = this.columnNames.length;
          if (numColumns !== 0) {
            assertTrue(parsedBatch.numCells % numColumns === 0);
            this._numRows += parsedBatch.numCells / numColumns;
          } else {
            // numColumns == 0 is  plausible for queries like CREATE TABLE ... .
            assertTrue(parsedBatch.numCells === 0);
          }
          break;
        default:
          console.warn(`Unexpected QueryResult field ${tag >>> 3}`);
          reader.skipType(tag & 7);
          break;
      }  // switch (tag)
    }    // while (pos < end)

    if (this._isComplete && this.allRowsPromise !== undefined) {
      this.resolveOrReject(this.allRowsPromise, this);
    }
  }

  ensureAllRowsPromise(): Promise<QueryResult> {
    if (this.allRowsPromise === undefined) {
      this.waitAllRows();  // Will populate |this.allRowsPromise|.
    }
    return assertExists(this.allRowsPromise);
  }

  private resolveOrReject(promise: Deferred<QueryResult>, arg: QueryResult) {
    if (this._error === undefined) {
      promise.resolve(arg);
    } else {
      promise.reject(new Error(this._error));
    }
  }
}

// This class holds onto a received result batch (a Uint8Array) and does some
// partial parsing to tokenize the various cell groups. This parsing mainly
// consists of identifying and caching the offsets of each cell group and
// initializing the varint decoders. This half parsing is done to keep the
// iterator's next() fast, without decoding everything into memory.
// This is an internal implementation detail and is not exposed outside. The
// RowIteratorImpl uses this class to iterate through batches (this class takes
// care of iterating within a batch, RowIteratorImpl takes care of switching
// batches when needed).
// Note: at any point in time there can be more than one ResultIterator
// referencing the same batch. The batch must be immutable.
class ResultBatch {
  readonly isLastBatch: boolean = false;
  readonly batchBytes: Uint8Array;
  readonly cellTypesOff: number = 0;
  readonly cellTypesLen: number = 0;
  readonly varintOff: number = 0;
  readonly varintLen: number = 0;
  readonly float64Cells = new Float64Array();
  readonly blobCells: Uint8Array[] = [];
  readonly stringCells: string[] = [];

  // batchBytes is a trace_processor.QueryResult.CellsBatch proto.
  constructor(batchBytes: Uint8Array) {
    this.batchBytes = batchBytes;
    const reader = protobuf.Reader.create(batchBytes);
    assertTrue(reader.pos === 0);
    const end = reader.len;

    // Here we deconstruct the proto by hand. The CellsBatch is carefully
    // designed to allow a very fast parsing from the TS side. We pack all cells
    // of the same types together, so we can do only one call (per batch) to
    // TextDecoder.decode(), we can overlay a memory-aligned typedarray for
    // float values and can quickly tell and type-check the cell types.
    // One row = N cells (we know the number upfront from the outer message).
    // Each bach contains always an integer multiple of N cells (i.e. rows are
    // never fragmented across different batches).
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:  // cell types, a packed array containing one CellType per cell.
          assertTrue((tag & 7) === TAG_LEN_DELIM);  // Must be packed varint.
          this.cellTypesLen = reader.uint32();
          this.cellTypesOff = reader.pos;
          reader.pos += this.cellTypesLen;
          break;

        case 2:  // varint_cells, a packed varint buffer.
          assertTrue((tag & 7) === TAG_LEN_DELIM);  // Must be packed varint.
          const packLen = reader.uint32();
          this.varintOff = reader.pos;
          this.varintLen = packLen;
          assertTrue(reader.buf === batchBytes);
          assertTrue(
              this.varintOff + this.varintLen <=
              batchBytes.byteOffset + batchBytes.byteLength);
          reader.pos += packLen;
          break;

        case 3:  // float64_cells, a 64-bit aligned packed fixed64 buffer.
          assertTrue((tag & 7) === TAG_LEN_DELIM);  // Must be packed varint.
          const f64Len = reader.uint32();
          assertTrue(f64Len % 8 === 0);
          // Float64Array's constructor is evil: the offset is in bytes but the
          // length is in 8-byte words.
          const f64Words = f64Len / 8;
          const f64Off = batchBytes.byteOffset + reader.pos;
          if (f64Off % 8 === 0) {
            this.float64Cells =
                new Float64Array(batchBytes.buffer, f64Off, f64Words);
          } else {
            // When using the production code in trace_processor's rpc.cc, the
            // float64 should be 8-bytes aligned. The slow-path case is only for
            // tests.
            const slice = batchBytes.buffer.slice(f64Off, f64Off + f64Len);
            this.float64Cells = new Float64Array(slice);
          }
          reader.pos += f64Len;
          break;

        case 4:  // blob_cells: one entry per blob.
          assertTrue((tag & 7) === TAG_LEN_DELIM);
          // protobufjs's bytes() under the hoods calls slice() and creates
          // a copy. Fine here as blobs are rare and not a fastpath.
          this.blobCells.push(new Uint8Array(reader.bytes()));
          break;

        case 5:  // string_cells: all the string cells concatenated with \0s.
          assertTrue((tag & 7) === TAG_LEN_DELIM);
          const strLen = reader.uint32();
          assertTrue(reader.pos + strLen <= end);
          const subArr = batchBytes.subarray(reader.pos, reader.pos + strLen);
          assertTrue(subArr.length === strLen);
          // The reason why we do this split rather than creating one string
          // per entry is that utf8 decoding has some non-negligible cost. See
          // go/postmessage-benchmark .
          this.stringCells = utf8Decode(subArr).split('\0');
          reader.pos += strLen;
          break;

        case 6:  // is_last_batch (boolean).
          this.isLastBatch = !!reader.bool();
          break;

        case 7:  // padding for realignment, skip silently.
          reader.skipType(tag & 7);
          break;

        default:
          console.warn(`Unexpected QueryResult.CellsBatch field ${tag >>> 3}`);
          reader.skipType(tag & 7);
          break;
      }  // switch(tag)
    }    // while (pos < end)
  }

  get numCells() {
    return this.cellTypesLen;
  }
}

class RowIteratorImpl implements RowIteratorBase {
  // The spec passed to the iter call containing the expected types, e.g.:
  // {'colA': NUM, 'colB': NUM_NULL, 'colC': STRING}.
  // This doesn't ever change.
  readonly rowSpec: Row;

  // The object that holds the current row. This points to the parent
  // RowIteratorImplWithRowData instance that created this class.
  rowData: Row;

  // The QueryResult object we are reading data from. The engine will pump
  // batches over time into this object.
  private resultObj: QueryResultImpl;

  // All the member variables in the group below point to the identically-named
  // members in result.batch[batchIdx]. This is to avoid indirection layers in
  // the next() hotpath, so we can do this.float64Cells vs
  // this.resultObj.batch[this.batchIdx].float64Cells.
  // These are re-set every time tryMoveToNextBatch() is called (and succeeds).
  private batchIdx = -1;  // The batch index within |result.batches[]|.
  private batchBytes = new Uint8Array();
  private columnNames: string[] = [];
  private numColumns = 0;
  private cellTypesEnd = -1;  // -1 so the 1st next() hits tryMoveToNextBatch().
  private float64Cells = new Float64Array();
  private varIntReader = protobuf.Reader.create(this.batchBytes);
  private blobCells: Uint8Array[] = [];
  private stringCells: string[] = [];

  // These members instead are incremented as we read cells from next(). They
  // are the mutable state of the iterator.
  private nextCellTypeOff = 0;
  private nextFloat64Cell = 0;
  private nextStringCell = 0;
  private nextBlobCell = 0;
  private isValid = false;

  constructor(querySpec: Row, rowData: Row, res: QueryResultImpl) {
    Object.assign(this, querySpec);
    this.rowData = rowData;
    this.rowSpec = {...querySpec};  // ... -> Copy all the key/value pairs.
    this.resultObj = res;
    this.next();
  }

  valid(): boolean {
    return this.isValid;
  }


  get(columnName: string): ColumnType {
    const res = this.rowData[columnName];
    if (res === undefined) {
      throw new Error(
          `Column '${columnName}' doesn't exist. ` +
          `Actual columns: [${this.columnNames.join(',')}]`);
    }
    return res;
  }

  // Moves the cursor next by one row and updates |isValid|.
  // When this fails to move, two cases are possible:
  // 1. We reached the end of the result set (this is the case if
  //    QueryResult.isComplete() == true when this fails).
  // 2. We reached the end of the current batch, but more rows might come later
  //    (if QueryResult.isComplete() == false).
  next() {
    // At some point we might reach the end of the current batch, but the next
    // batch might be available already. In this case we want next() to
    // transparently move on to the next batch.
    while (this.nextCellTypeOff + this.numColumns > this.cellTypesEnd) {
      // If TraceProcessor is behaving well, we should never end up in a
      // situation where we have leftover cells. TP is expected to serialize
      // whole rows in each QueryResult batch and NOT truncate them midway.
      // If this assert fires the TP RPC logic has a bug.
      assertTrue(
          this.nextCellTypeOff === this.cellTypesEnd ||
          this.cellTypesEnd === -1);
      if (!this.tryMoveToNextBatch()) {
        this.isValid = false;
        return;
      }
    }

    const rowData = this.rowData;
    const numColumns = this.numColumns;

    // Read the current row.
    for (let i = 0; i < numColumns; i++) {
      const cellType = this.batchBytes[this.nextCellTypeOff++];
      const colName = this.columnNames[i];

      switch (cellType) {
        case CellType.CELL_NULL:
          rowData[colName] = null;
          break;

        case CellType.CELL_VARINT:
          const val = this.varIntReader.int64();
          // This is very subtle. The return type of int64 can be either a
          // number or a Long.js {high:number, low:number} if Long.js support is
          // enabled. The default state seems different in node and browser.
          // We force-disable Long.js support in the top of this source file.
          rowData[colName] = val as {} as number;
          break;

        case CellType.CELL_FLOAT64:
          rowData[colName] = this.float64Cells[this.nextFloat64Cell++];
          break;

        case CellType.CELL_STRING:
          rowData[colName] = this.stringCells[this.nextStringCell++];
          break;

        case CellType.CELL_BLOB:
          const blob = this.blobCells[this.nextBlobCell++];
          throw new Error(`TODO implement BLOB support (${blob})`);
          // outRow[colName] = blob;
          break;

        default:
          throw new Error(`Invalid cell type ${cellType}`);
      }
    }  // For (cells)
    this.isValid = true;
  }

  private tryMoveToNextBatch(): boolean {
    const nextBatchIdx = this.batchIdx + 1;
    if (nextBatchIdx >= this.resultObj.batches.length) {
      return false;
    }

    this.columnNames = this.resultObj.columnNames;
    this.numColumns = this.columnNames.length;

    this.batchIdx = nextBatchIdx;
    const batch = assertExists(this.resultObj.batches[nextBatchIdx]);
    this.batchBytes = batch.batchBytes;
    this.nextCellTypeOff = batch.cellTypesOff;
    this.cellTypesEnd = batch.cellTypesOff + batch.cellTypesLen;
    this.float64Cells = batch.float64Cells;
    this.blobCells = batch.blobCells;
    this.stringCells = batch.stringCells;
    this.varIntReader = protobuf.Reader.create(batch.batchBytes);
    this.varIntReader.pos = batch.varintOff;
    this.varIntReader.len = batch.varintOff + batch.varintLen;
    this.nextFloat64Cell = 0;
    this.nextStringCell = 0;
    this.nextBlobCell = 0;

    // Check that all the expected columns are present.
    for (const expectedCol of Object.keys(this.rowSpec)) {
      if (this.columnNames.indexOf(expectedCol) < 0) {
        throw new Error(
            `Column ${expectedCol} not found in the SQL result ` +
            `set {${this.columnNames.join(' ')}}`);
      }
    }

    // Check that the cells types are consistent.
    const numColumns = this.numColumns;
    if (batch.numCells === 0) {
      // This can happen if the query result contains just an error. In this
      // an empty batch with isLastBatch=true is appended as an EOF marker.
      // In theory TraceProcessor could return an empty batch in the middle and
      // that would be fine from a protocol viewpoint. In practice, no code path
      // does that today so it doesn't make sense trying supporting it with a
      // recursive call to tryMoveToNextBatch().
      assertTrue(batch.isLastBatch);
      return false;
    }

    assertTrue(numColumns > 0);
    for (let i = this.nextCellTypeOff; i < this.cellTypesEnd; i++) {
      const col = (i - this.nextCellTypeOff) % numColumns;
      const colName = this.columnNames[col];
      const actualType = this.batchBytes[i] as CellType;
      const expType = this.rowSpec[colName];

      // If undefined, the caller doesn't want to read this column at all, so
      // it can be whatever.
      if (expType === undefined) continue;

      let err = '';
      if (actualType === CellType.CELL_NULL &&
          (expType !== STR_NULL && expType !== NUM_NULL)) {
        err = 'SQL value is NULL but that was not expected' +
            ` (expected type: ${columnTypeToString(expType)}). ` +
            'Did you intend to use NUM_NULL or STR_NULL?';
      } else if (
          ((actualType === CellType.CELL_VARINT ||
            actualType === CellType.CELL_FLOAT64) &&
           (expType !== NUM && expType !== NUM_NULL)) ||
          ((actualType === CellType.CELL_STRING) &&
           (expType !== STR && expType !== STR_NULL))) {
        err = `Incompatible cell type. Expected: ${
            columnTypeToString(
                expType)} actual: ${CELL_TYPE_NAMES[actualType]}`;
      }
      if (err.length > 0) {
        throw new Error(
            `Error @ row: ${Math.floor(i / numColumns)} col: '` +
            `${colName}': ${err}`);
      }
    }
    return true;
  }
}

// This is the object ultimately returned to the client when calling
// QueryResult.iter(...).
// The only reason why this is disjoint from RowIteratorImpl is to avoid
// naming collisions between the members variables required by RowIteratorImpl
// and the column names returned by the iterator.
class RowIteratorImplWithRowData implements RowIteratorBase {
  private _impl: RowIteratorImpl;

  next: () => void;
  valid: () => boolean;
  get: (columnName: string) => ColumnType;

  constructor(querySpec: Row, res: QueryResultImpl) {
    const thisAsRow = this as {} as Row;
    Object.assign(thisAsRow, querySpec);
    this._impl = new RowIteratorImpl(querySpec, thisAsRow, res);
    this.next = this._impl.next.bind(this._impl);
    this.valid = this._impl.valid.bind(this._impl);
    this.get = this._impl.get.bind(this._impl);
  }
}

// This is a proxy object that wraps QueryResultImpl, adding await-ability.
// This is so that:
// 1. Clients that just want to await for the full result set can just call
//    await engine.query('...') and will get a QueryResult that is guaranteed
//    to be complete.
// 2. Clients that know how to handle the streaming can use it straight away.
class WaitableQueryResultImpl implements QueryResult, WritableQueryResult,
                                         PromiseLike<QueryResult> {
  private impl = new QueryResultImpl();
  private thenCalled = false;

  // QueryResult implementation. Proxies all calls to the impl object.
  iter<T extends Row>(spec: T) {
     return this.impl.iter(spec);
  }
  firstRow<T extends Row>(spec: T) {
     return this.impl.firstRow(spec);
  }
  waitAllRows() {
     return this.impl.waitAllRows();
  }
  isComplete() {
     return this.impl.isComplete();
  }
  numRows() {
     return this.impl.numRows();
  }
  columns() {
    return this.impl.columns();
  }
  error() {
     return this.impl.error();
  }

  // WritableQueryResult implementation.
  appendResultBatch(resBytes: Uint8Array) {
    return this.impl.appendResultBatch(resBytes);
  }

  // PromiseLike<QueryResult> implementaton.

  // tslint:disable-next-line no-any
  then(onfulfilled: any, onrejected: any): any {
    assertFalse(this.thenCalled);
    this.thenCalled = true;
    return this.impl.ensureAllRowsPromise().then(onfulfilled, onrejected);
  }

  // tslint:disable-next-line no-any
  catch(error: any): any {
    return this.impl.ensureAllRowsPromise().catch(error);
  }

  // tslint:disable-next-line no-any
  finally(callback: () => void): any {
    return this.impl.ensureAllRowsPromise().finally(callback);
  }

  get[Symbol.toStringTag](): string {
    return 'Promise<WaitableQueryResult>';
  }
}

export function createQueryResult(): QueryResult&Promise<QueryResult>&
    WritableQueryResult {
  return new WaitableQueryResultImpl();
}
