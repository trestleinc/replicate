# Runtime provenance

The browser runtime is copied from the original wa-sqlite repository at Git
commit `07ad48cf2f682d279f9cd69818cc1d39b2ccda86`. Replicate installs that commit's
immutable GitHub codeload archive directly. The package metadata reports version
1.1.2, but this dependency is a commit-pinned source archive, not an npm release
or a claim about the repository's similarly named tags.

The runtime files, MIT `LICENSE`, and complete `ACKNOWLEDGMENTS.md` listed in
`manifest.json` are byte-identical to that commit. The JavaScript loader was last
changed at `c17fe55df5d3b9da82ab34aa6b356a8a90eaa023`; the WebAssembly artifact was
last changed at `b0d5ff44548ce8a5c76f360a416c2d4321ed3c10`. The shipped module reports
SQLite 3.53.0, matching the Makefile. The installed archive has no runtime
dependencies or install, prepare, prepack, or build hooks.

The archive integrity and per-file hashes identify the installed source and
prebuilt artifacts; they do not independently reproduce the compiler toolchain
or the WebAssembly build.
