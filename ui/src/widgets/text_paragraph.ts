// Copyright (C) 2023 The Android Open Source Project
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

import m from 'mithril';
import {classNames} from '../base/classnames';

export interface TextParagraphAttrs {
  // Paragraph text.
  text: string;
  // Whether to compress multiple spaces (e.g. the string is multi-line but
  // should render with the default UI wrapping)
  compressSpace?: boolean;
  // Remaining attributes forwarded to the underlying HTML <section>.
  [htmlAttrs: string]: any;
}

export class TextParagraph implements m.ClassComponent<TextParagraphAttrs> {
  view({attrs}: m.CVnode<TextParagraphAttrs>) {
    let {text, compressSpace} = attrs;
    if (compressSpace === undefined) {
      compressSpace = true;
    }
    return m(
        `div.pf-text-paragraph`,
        compressSpace ? text.replace(/\s\s+/g, ' ') : text);
  }
}

interface MultiParagraphTextAttrs {
  // Space delimited class list applied to element.
  className?: string;
}

export class MultiParagraphText implements
    m.ClassComponent<MultiParagraphTextAttrs> {
  view({attrs, children}: m.Vnode<MultiParagraphTextAttrs>): m.Children {
    const {
      className = '',
    } = attrs;

    const classes = classNames(
        className,
    );

    return m('div', {class: classes}, children);
  }
}