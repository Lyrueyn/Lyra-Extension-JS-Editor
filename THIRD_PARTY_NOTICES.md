# Third-party notices

Lyra JavaScript Editor is licensed under GPL-3.0-only (see LICENSE).
It bundles the following third-party libraries. Each remains under its own
license; the GPL applies to the project as a whole and does not relicense
these components.

## CodeMirror 5

Files under `vendor/codemirror/`.

Copyright (C) 2014 by Marijn Haverbeke <marijn@haverbeke.berlin> and others.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## Acorn

Files under `vendor/lint/acorn.js`.

Copyright (C) 2012-2024 by various contributors (see the Acorn AUTHORS file).

MIT License — same permission text as CodeMirror above.

## acorn-walk

Files under `vendor/lint/acorn-walk.js`.

Copyright (C) 2012-2024 by various contributors.

MIT License — same permission text as CodeMirror above.

## js-beautify

Files under `vendor/lint/beautify.js`.

Copyright (C) 2007-2024 Einar Lielmanis, <einar@beautifier.io> and contributors.

MIT License — same permission text as CodeMirror above.


## acorn-loose

Files under `vendor/lint/acorn-loose.js`.

Copyright (C) 2012-2024 by various contributors.

MIT License — same permission text as CodeMirror above.

## ESLint

Files under `vendor/eslint/linter.min.js` (eslint-linter-browserify bundle).

Copyright OpenJS Foundation and other contributors, <https://openjsf.org/>.

MIT License — same permission text as CodeMirror above. The bundle also
contains ESLint's transitive dependencies under their respective MIT licenses.


## Monaco Editor / TypeScript language service

Files under `vendor/monaco-ts.min.js` and `vendor/monaco-completion.js`.

- Monaco Editor: Copyright (c) Microsoft Corporation. MIT License.
- TypeScript compiler / language service and lib files: Copyright (c) Microsoft
  Corporation. Apache License 2.0.
- Full notices: `vendor/MONACO-LICENSE.txt`,
  `vendor/MONACO-THIRD-PARTY-NOTICES.txt`.

The editor uses Monaco's bundled TypeScript language service for autocomplete
only; Monaco's UI is not loaded.
