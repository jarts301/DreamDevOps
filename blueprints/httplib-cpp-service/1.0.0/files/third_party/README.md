# Third-party code

The service's two libraries are kept here, each a single header, so every build uses exactly these, as a lockfile would pin them. Each is unchanged from where it came from, and `SHA256SUMS` holds its checksum, which the pipeline checks. From the service's folder:

```bash
sha256sum -c third_party/SHA256SUMS
```

| Library | Version | File | SHA-256 | Licence |
|---|---|---|---|---|
| [cpp-httplib](https://github.com/yhirose/cpp-httplib), the HTTP server and client | 0.41.0 | `httplib/httplib.h` | `e9112546cbae828180f72c2ae6da4bfd8d15ae38138bd99b898e5e30128acc28` | MIT, in `httplib/LICENSE` |
| [doctest](https://github.com/doctest/doctest), for the tests | 2.5.3 | `doctest/doctest.h` | `cfd518a3ef90f67e1f3ba514df23fb3627437de1a2feeba78cf5062a40021421` | MIT, in `doctest/LICENSE.txt` |

cpp-httplib's header is from Debian's source of it, `cpp-httplib_0.41.0+ds.orig.tar.xz`, and doctest's is from Debian's `doctest-dev` 2.5.3-1 package. Both are the projects' own releases.

To update one, replace its header with the new release's, from the project or a distribution you trust, and its version and checksum here and in `SHA256SUMS`. Then build and run the tests.
