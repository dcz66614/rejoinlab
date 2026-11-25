# Third-Party Notices — RejoinLab (P031)

- Project: RejoinLab (P031), spec v1.0.2, MIT.
- Generated: 2026-11-23, from the installed `node_modules/` tree at HEAD
  `daa3a37` (frozen by T013). Every row below was read from that package's
  own `package.json` (`license` field) and its installed version — nothing
  was guessed from a registry page.
- Method: `node_modules/` was enumerated in full (137 packages). Direct
  dependencies are the 12 packages named in `package.json`
  (`dependencies` + `devDependencies`). Transitive "via" entries name the
  packages that list the row as a dependency in `package-lock.json`
  (first two shown when there are more).
- The Python Oracle (`oracle/`) uses the Python 3.12 standard library only
  and has no third-party Python dependencies.
- License texts: the full text of each license named below ships inside the
  corresponding package directory under `node_modules/<package>/`
  (`LICENSE`, `LICENSE.md`, `LICENSE.txt`, or equivalent). This file records
  the SPDX identifier and version; it does not reproduce 137 license texts.

## Summary

| License | Packages | Notes |
|---|---|---|
| MIT | 117 | Includes the runtime (react, react-dom) and most tooling. |
| Apache-2.0 | 8 | TypeScript; Playwright (`@playwright/test`, `playwright`, `playwright-core`); `aria-query`, `baseline-browser-mapping`, `expect-type`, `xml-name-validator`. |
| ISC | 7 | `electron-to-chromium`, `lru-cache`, `picocolors`, `saxes`, `semver`, `siginfo`, `yallist`. |
| BSD-2-Clause | 2 | `entities`, `webidl-conversions`. |
| BSD-3-Clause | 2 | `source-map-js`, `tough-cookie`. |
| CC-BY-4.0 | 1 | `caniuse-lite` (data license; it is a browserslist/caniuse data package, not code). |
| **Total** | **137** | **12 direct + 125 transitive.** |

No copyleft license (GPL / LGPL / AGPL / MPL) is present in the tree. No
package has a missing or unparseable license field. If any dependency is
added, removed, or upgraded, re-run the enumeration in
`scripts/verify-licenses.ts` (`npm run verify:licenses`) and update this
file — do not edit versions by hand.

## Direct dependencies (12)

| Package | Version | License | Use |
|---|---|---|---|
| react | 19.3.1 | MIT | UI framework (runtime) |
| react-dom | 19.3.1 | MIT | React DOM renderer (runtime) |
| @playwright/test | 1.65.1 | Apache-2.0 | Browser E2E tests (dev) |
| @testing-library/dom | 10.4.1 | MIT | DOM test utilities (dev) |
| @testing-library/react | 16.3.3 | MIT | React component test utilities (dev) |
| @types/react | 19.3.0 | MIT | TypeScript types for React (dev) |
| @types/react-dom | 19.3.0 | MIT | TypeScript types for react-dom (dev) |
| @vitejs/plugin-react | 5.2.0 | MIT | Vite React plugin, incl. Fast Refresh (dev) |
| jsdom | 31.0.1 | MIT | DOM implementation for the vitest jsdom environment (dev) |
| typescript | 5.9.3 | Apache-2.0 | Type checker (dev) |
| vite | 7.3.8 | MIT | Build tool + dev server (dev) |
| vitest | 4.1.12 | MIT | Test runner (dev) |

Versions above are the installed versions read from `node_modules/` at
generation time; they match `package-lock.json`. The `verify:licenses`
script re-checks every direct dependency's recorded version against the
installed version on each run.

## All packages (137)

| Package | Version | License | Scope | Use |
|---|---|---|---|---|
| @babel/code-frame | 7.29.7 | MIT | transitive | transitive via @babel/core, @babel/template… |
| @babel/compat-data | 7.29.7 | MIT | transitive | transitive via @babel/helper-compilation-targets |
| @babel/core | 7.29.13 | MIT | transitive | transitive via @babel/helper-module-transforms, @babel/plugin-transform-react-jsx-self… |
| @babel/generator | 7.29.15 | MIT | transitive | transitive via @babel/core, @babel/traverse |
| @babel/helper-compilation-targets | 7.29.13 | MIT | transitive | transitive via @babel/core |
| @babel/helper-globals | 7.29.7 | MIT | transitive | transitive via @babel/traverse |
| @babel/helper-module-imports | 7.29.7 | MIT | transitive | transitive via @babel/helper-module-transforms |
| @babel/helper-module-transforms | 7.29.14 | MIT | transitive | transitive via @babel/core |
| @babel/helper-plugin-utils | 7.29.7 | MIT | transitive | transitive via @babel/plugin-transform-react-jsx-self, @babel/plugin-transform-react-jsx-source |
| @babel/helper-string-parser | 7.29.15 | MIT | transitive | transitive via @babel/types |
| @babel/helper-validator-identifier | 7.29.7 | MIT | transitive | transitive via @babel/code-frame, @babel/helper-module-transforms… |
| @babel/helper-validator-option | 7.29.7 | MIT | transitive | transitive via @babel/helper-compilation-targets |
| @babel/helpers | 7.29.15 | MIT | transitive | transitive via @babel/core |
| @babel/parser | 7.29.15 | MIT | transitive | transitive via @babel/core, @babel/generator… |
| @babel/plugin-transform-react-jsx-self | 7.29.7 | MIT | transitive | transitive via @vitejs/plugin-react |
| @babel/plugin-transform-react-jsx-source | 7.29.7 | MIT | transitive | transitive via @vitejs/plugin-react |
| @babel/runtime | 7.29.15 | MIT | transitive | transitive via @testing-library/dom, @testing-library/react |
| @babel/template | 7.29.7 | MIT | transitive | transitive via @babel/core, @babel/helpers… |
| @babel/traverse | 7.29.15 | MIT | transitive | transitive via @babel/core, @babel/helper-module-imports… |
| @babel/types | 7.29.15 | MIT | transitive | transitive via @babel/core, @babel/generator… |
| @esbuild/linux-x64 | 0.28.2 | MIT | transitive | transitive |
| @exodus/bytes | 1.16.0 | MIT | transitive | transitive via html-encoding-sniffer, jsdom… |
| @jridgewell/gen-mapping | 0.3.13 | MIT | transitive | transitive via @babel/generator, @jridgewell/remapping |
| @jridgewell/remapping | 2.3.5 | MIT | transitive | transitive via @babel/core |
| @jridgewell/resolve-uri | 3.1.3 | MIT | transitive | transitive via @jridgewell/trace-mapping |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT | transitive | transitive via @jridgewell/gen-mapping, @jridgewell/trace-mapping… |
| @jridgewell/trace-mapping | 0.3.31 | MIT | transitive | transitive via @babel/generator, @jridgewell/gen-mapping… |
| @playwright/test | 1.65.1 | Apache-2.0 | direct (dev) | browser E2E tests |
| @rolldown/pluginutils | 1.0.0-rc.3 | MIT | transitive | transitive via @vitejs/plugin-react |
| @rollup/rollup-linux-x64-gnu | 4.68.8 | MIT | transitive | transitive |
| @rollup/rollup-linux-x64-musl | 4.68.8 | MIT | transitive | transitive |
| @standard-schema/spec | 1.1.0 | MIT | transitive | transitive via @vitest/expect |
| @testing-library/dom | 10.4.1 | MIT | direct (dev) | DOM test utilities |
| @testing-library/react | 16.3.3 | MIT | direct (dev) | React component test utilities |
| @types/aria-query | 5.0.4 | MIT | transitive | transitive via @testing-library/dom |
| @types/babel__core | 7.20.5 | MIT | transitive | transitive via @vitejs/plugin-react |
| @types/babel__generator | 7.27.0 | MIT | transitive | transitive via @types/babel__core |
| @types/babel__template | 7.4.4 | MIT | transitive | transitive via @types/babel__core |
| @types/babel__traverse | 7.28.0 | MIT | transitive | transitive via @types/babel__core |
| @types/chai | 5.2.3 | MIT | transitive | transitive via @vitest/expect |
| @types/deep-eql | 4.0.2 | MIT | transitive | transitive via @types/chai |
| @types/estree | 1.0.10 | MIT | transitive | transitive via estree-walker, rollup |
| @types/react | 19.3.0 | MIT | direct (dev) | TypeScript types for React |
| @types/react-dom | 19.3.0 | MIT | direct (dev) | TypeScript types for react-dom |
| @vitejs/plugin-react | 5.2.0 | MIT | direct (dev) | Vite React plugin (Fast Refresh) |
| @vitest/expect | 4.1.12 | MIT | transitive | transitive via vitest |
| @vitest/mocker | 4.1.12 | MIT | transitive | transitive via vitest |
| @vitest/pretty-format | 4.1.12 | MIT | transitive | transitive via @vitest/snapshot, @vitest/utils… |
| @vitest/runner | 4.1.12 | MIT | transitive | transitive via vitest |
| @vitest/snapshot | 4.1.12 | MIT | transitive | transitive via vitest |
| @vitest/spy | 4.1.12 | MIT | transitive | transitive via @vitest/expect, @vitest/mocker… |
| @vitest/utils | 4.1.12 | MIT | transitive | transitive via @vitest/expect, @vitest/runner… |
| ansi-regex | 5.0.1 | MIT | transitive | transitive via pretty-format |
| ansi-styles | 5.2.0 | MIT | transitive | transitive via pretty-format |
| aria-query | 5.3.0 | Apache-2.0 | transitive | transitive via @testing-library/dom |
| assertion-error | 2.0.1 | MIT | transitive | transitive via @types/chai |
| baseline-browser-mapping | 2.11.39 | Apache-2.0 | transitive | transitive via browserslist |
| bcp-47 | 2.1.2 | MIT | transitive | transitive via jsdom |
| bcp-47-match | 2.0.3 | MIT | transitive | transitive via jsdom |
| browserslist | 4.29.6 | MIT | transitive | transitive via @babel/helper-compilation-targets, update-browserslist-db |
| caniuse-lite | 1.0.30001827 | CC-BY-4.0 | transitive | transitive via browserslist |
| chai | 6.3.0 | MIT | transitive | transitive via @vitest/expect |
| convert-source-map | 2.0.0 | MIT | transitive | transitive via @babel/core, @vitest/utils |
| csstype | 3.2.4 | MIT | transitive | transitive via @types/react |
| data-urls | 8.0.0 | MIT | transitive | transitive via jsdom |
| debug | 4.4.3 | MIT | transitive | transitive via @babel/core, @babel/traverse |
| decimal.js | 10.6.0 | MIT | transitive | transitive via jsdom |
| dequal | 2.0.3 | MIT | transitive | transitive via aria-query |
| dom-accessibility-api | 0.5.16 | MIT | transitive | transitive via @testing-library/dom |
| electron-to-chromium | 1.5.492 | ISC | transitive | transitive via browserslist |
| entities | 9.0.0 | BSD-2-Clause | transitive | transitive via parse5 |
| es-module-lexer | 2.3.2 | MIT | transitive | transitive via vitest |
| esbuild | 0.28.2 | MIT | transitive | transitive via vite |
| escalade | 3.2.0 | MIT | transitive | transitive via update-browserslist-db |
| estree-walker | 3.0.3 | MIT | transitive | transitive via @vitest/mocker |
| expect-type | 1.4.0 | Apache-2.0 | transitive | transitive via vitest |
| fdir | 6.5.0 | MIT | transitive | transitive via tinyglobby, vite |
| gensync | 1.0.0-beta.2 | MIT | transitive | transitive via @babel/core |
| html-encoding-sniffer | 7.0.0 | MIT | transitive | transitive via jsdom |
| is-alphabetical | 2.0.1 | MIT | transitive | transitive via bcp-47, is-alphanumerical |
| is-alphanumerical | 2.0.1 | MIT | transitive | transitive via bcp-47 |
| is-decimal | 2.0.1 | MIT | transitive | transitive via bcp-47, is-alphanumerical |
| is-potential-custom-element-name | 1.0.1 | MIT | transitive | transitive via jsdom |
| js-tokens | 4.0.0 | MIT | transitive | transitive via @babel/code-frame |
| jsdom | 31.0.1 | MIT | direct (dev) | DOM implementation for vitest jsdom environment |
| jsesc | 3.1.0 | MIT | transitive | transitive via @babel/generator |
| json5 | 2.2.3 | MIT | transitive | transitive via @babel/core |
| lru-cache | 5.1.1 | ISC | transitive | transitive via @babel/helper-compilation-targets, jsdom |
| lz-string | 1.5.0 | MIT | transitive | transitive via @testing-library/dom |
| magic-string | 0.30.21 | MIT | transitive | transitive via @vitest/mocker, @vitest/snapshot… |
| ms | 2.1.3 | MIT | transitive | transitive via debug |
| nanoid | 3.3.20 | MIT | transitive | transitive via postcss |
| node-releases | 2.0.65 | MIT | transitive | transitive via browserslist |
| obug | 2.2.1 | MIT | transitive | transitive via vitest |
| parse5 | 8.1.1 | MIT | transitive | transitive via jsdom, parse5-parser-stream |
| parse5-parser-stream | 8.1.1 | MIT | transitive | transitive via jsdom |
| pathe | 2.0.3 | MIT | transitive | transitive via @vitest/runner, @vitest/snapshot… |
| picocolors | 1.1.1 | ISC | transitive | transitive via @babel/code-frame, @testing-library/dom… |
| picomatch | 4.0.7 | MIT | transitive | transitive via fdir, tinyglobby… |
| playwright | 1.65.1 | Apache-2.0 | transitive | transitive via @playwright/test |
| playwright-core | 1.65.1 | Apache-2.0 | transitive | transitive via playwright |
| postcss | 8.5.33 | MIT | transitive | transitive via vite |
| pretty-format | 27.5.1 | MIT | transitive | transitive via @testing-library/dom |
| punycode | 2.3.1 | MIT | transitive | transitive via tr46 |
| react | 19.3.1 | MIT | direct (runtime) | UI framework (runtime) |
| react-dom | 19.3.1 | MIT | direct (runtime) | React DOM renderer (runtime) |
| react-is | 17.0.2 | MIT | transitive | transitive via pretty-format |
| react-refresh | 0.18.0 | MIT | transitive | transitive via @vitejs/plugin-react |
| rollup | 4.68.8 | MIT | transitive | transitive via vite |
| saxes | 6.0.0 | ISC | transitive | transitive via jsdom |
| scheduler | 0.28.0 | MIT | transitive | transitive via react-dom |
| semver | 6.3.2 | ISC | transitive | transitive via @babel/core, @babel/helper-compilation-targets |
| siginfo | 2.0.0 | ISC | transitive | transitive via why-is-node-running |
| source-map-js | 1.2.4 | BSD-3-Clause | transitive | transitive via postcss |
| stackback | 0.0.2 | MIT | transitive | transitive via why-is-node-running |
| std-env | 4.3.0 | MIT | transitive | transitive via vitest |
| tinybench | 2.9.0 | MIT | transitive | transitive via vitest |
| tinyexec | 1.3.1 | MIT | transitive | transitive via vitest |
| tinyglobby | 0.2.17 | MIT | transitive | transitive via vite, vitest |
| tinyrainbow | 3.2.0 | MIT | transitive | transitive via @vitest/expect, @vitest/pretty-format… |
| tldts | 7.5.5 | MIT | transitive | transitive via tough-cookie |
| tldts-core | 7.5.5 | MIT | transitive | transitive via tldts |
| tough-cookie | 6.1.0 | BSD-3-Clause | transitive | transitive via jsdom |
| tr46 | 7.0.0 | MIT | transitive | transitive via whatwg-url |
| typescript | 5.9.3 | Apache-2.0 | direct (dev) | type checker |
| undici | 8.13.1 | MIT | transitive | transitive via jsdom |
| update-browserslist-db | 1.4.0 | MIT | transitive | transitive via browserslist |
| vite | 7.3.8 | MIT | direct (dev) | build tool + dev server |
| vitest | 4.1.12 | MIT | direct (dev) | test runner |
| w3c-xmlserializer | 6.0.0 | MIT | transitive | transitive via jsdom |
| webidl-conversions | 8.0.1 | BSD-2-Clause | transitive | transitive via jsdom, whatwg-url |
| whatwg-mimetype | 5.0.0 | MIT | transitive | transitive via data-urls, jsdom |
| whatwg-url | 17.3.0 | MIT | transitive | transitive via data-urls, jsdom |
| why-is-node-running | 2.3.0 | MIT | transitive | transitive via vitest |
| xml-name-validator | 5.0.0 | Apache-2.0 | transitive | transitive via jsdom, w3c-xmlserializer |
| xmlchars | 2.2.0 | MIT | transitive | transitive via saxes |
| yallist | 3.1.1 | ISC | transitive | transitive via lru-cache |
