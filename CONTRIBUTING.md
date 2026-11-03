# Contributing to Mirage

Mirage is licensed under the GNU Affero General Public License, version 3 or later (AGPL-3.0-or-later). The full text is in `LICENSE`.

## Licence of contributions

Contributions are accepted under the same licence. Every commit needs a DCO sign-off, which says you wrote the change or have the right to submit it under this licence. Add it with:

```bash
git commit -s
```

That appends a `Signed-off-by:` line to the commit message. The sign-off refers to the Developer Certificate of Origin 1.1, which you can read at https://developercertificate.org.

New source files start with `// SPDX-License-Identifier: AGPL-3.0-or-later`.

## Before you open a pull request

```bash
pnpm test && pnpm typecheck
```

Both must pass.

## Where code and text come from

Don't copy code or text from projects whose licence doesn't allow it. If you adapt something, say where it came from in the pull request so the licence can be checked.
