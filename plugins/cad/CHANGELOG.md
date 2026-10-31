# Changelog

## [0.3.1](https://github.com/srobroek/opencode-plugins/compare/cad--v0.3.0...cad--v0.3.1) (2026-10-31)


### Documentation

* **cad:** tighten skill prose flagged by slopvac (omp b476fb9b9b) ([#93](https://github.com/srobroek/opencode-plugins/issues/93)) ([83ce12e](https://github.com/srobroek/opencode-plugins/commit/83ce12e2ad83b013f9aa849f14b2723c6dc32fc5))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/cad--v0.2.0...cad--v0.3.0) (2026-10-31)


### ⚠ BREAKING CHANGES

* **cad:** check minimum walls per process and limit block_like to solid parts (omp dc89664da1)
* **cad:** the pair cache moves to hw/.cad/pairs-v2.sqlite; a sweep whose between-sample check leaves an interval unproved now reports status "incomplete" and exits 2 (use --no-continuous for a sampled-only run); sweep run records live under hw/.cad/runs/; timings_s counters are renamed (kernel_evaluations, exact_hits, ...).
* **cad:** catch missing retention and see-through FDM parts at L2 (omp d761ee995e)

### Features

* **cad:** build only changed parts, store part outputs once, and keep results out of git unless approved (omp 0d8c248fbb) ([d319f02](https://github.com/srobroek/opencode-plugins/commit/d319f0271da01def8b4b6e8de54ddd9719292651))
* **cad:** catch missing retention and see-through FDM parts at L2 (omp d761ee995e) ([92eb578](https://github.com/srobroek/opencode-plugins/commit/92eb5781fbc1786436e37d17794fd5a28234638c))
* **cad:** check minimum walls per process and limit block_like to solid parts (omp dc89664da1) ([9106b4a](https://github.com/srobroek/opencode-plugins/commit/9106b4a8be44fcdf6e231552bc22368bab9334a0))
* **cad:** check requirement window visibility and reuse unchanged views in renders (omp 94dbb08876) ([24cb056](https://github.com/srobroek/opencode-plugins/commit/24cb0568a0ec3ad029d7bc8bdc304554709c6a62))
* **cad:** check versions fail-fast and close each built stage with provisional and human gates (omp 6923317bea) ([52f9107](https://github.com/srobroek/opencode-plugins/commit/52f9107cb5b915768609b37c2d0f34fa24b847cf))
* **cad:** prune versions after release and generate record docs (omp e229d40af6) ([7a3087b](https://github.com/srobroek/opencode-plugins/commit/7a3087babc7bd1986b6708d81735eb9910f6d303))
* **cad:** render custom view directions and assess shadows only when the floor is in frame (omp 12031db46e) ([cb714e7](https://github.com/srobroek/opencode-plugins/commit/cb714e7d8c09dd16623526854800443cb2f8a029))
* **cad:** sweep v2 with between-sample proofs, subsystem runs and merges (omp 98102a0c14) ([5b8c55e](https://github.com/srobroek/opencode-plugins/commit/5b8c55e1e33ef8e6f89c51fb05ffc777db14b884))
* **cad:** tolerate cosmetic fillet failures and smoke FreeCAD runs (omp 358cdb2589) ([aa0956e](https://github.com/srobroek/opencode-plugins/commit/aa0956e8af27bc909c5831042893f10f4cfd26eb))


### Bug Fixes

* **cad:** diagnose CalculiX crashes and timeouts, and allow per-case FEA time limits (omp a2b4fb0805) ([83cdb09](https://github.com/srobroek/opencode-plugins/commit/83cdb09ec42a1f683b4a882f1fb9a0edad164e4c))
* **cad:** dimension hole centres from datum planes and print feature tolerances on drawings (omp b3dbfe71d2) ([2b48ecf](https://github.com/srobroek/opencode-plugins/commit/2b48ecf9b2ffbab5a92fb3197e321077f66aee39))
* **cad:** distinguish blocks from planar frames (omp 9e080107af) ([d9c6c17](https://github.com/srobroek/opencode-plugins/commit/d9c6c17638e053210d2b027235940a78d0b51594))
* **cad:** repair tool defects found by the Claude Code E2E run (omp beea91e528) ([3c572a2](https://github.com/srobroek/opencode-plugins/commit/3c572a214e86ad9606adf609d63020e762482003))


### Performance

* **cad:** clear far pair-poses by mesh bounds and reuse periodic placements in sweeps (omp 30083fc8fc) ([eac420c](https://github.com/srobroek/opencode-plugins/commit/eac420c05689502b0de5374bad92df9e22ac3f17))


### Documentation

* **cad:** reopen every later step on a VOID and capitalise sentence-initial skill names ([a6a9878](https://github.com/srobroek/opencode-plugins/commit/a6a9878aa7192f9f4af16b842bbca51c1bb9d3d3))
* **cad:** state that visibility fractions apply to each target (omp 4e9488e0c7) ([d418f70](https://github.com/srobroek/opencode-plugins/commit/d418f70ecf4d43a07d8ed79f90ff8a3e6f3dd264))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/cad--v0.1.0...cad--v0.2.0) (2026-10-30)


### Features

* **cad:** add the CAD design plugin ([5ab26cc](https://github.com/srobroek/opencode-plugins/commit/5ab26cc146b5cb1e65aa26e7cbdd8d6f7cc9a1b7))


### Bug Fixes

* **cad:** ignore scratch build output on delivery ([949b3b2](https://github.com/srobroek/opencode-plugins/commit/949b3b2e189988f39da902b193f024ca2d565dde))
* **cad:** keep the cad_stop first description line within its limit ([963af73](https://github.com/srobroek/opencode-plugins/commit/963af7398a1528fc236b6475bdd3de89a3f88cc6))
* **cad:** launch reserved-name scripts in the shared environment ([7349c77](https://github.com/srobroek/opencode-plugins/commit/7349c77d190d526a5524796e72e1fc3c4f11b48b))
* **cad:** never signal a background job after it exits ([c72234e](https://github.com/srobroek/opencode-plugins/commit/c72234e3e0d6f904a4517b515deadb2b25e7ba7e))
* **cad:** refuse an existing version label, save viewer screenshots, document cad_stop after a restart ([ec7b934](https://github.com/srobroek/opencode-plugins/commit/ec7b9348504c12a08c33a0e0fe4e4aeba605b58d))
* **cad:** serve the concept viewer's pinned three.js modules ([39cb76f](https://github.com/srobroek/opencode-plugins/commit/39cb76fe5b832c6fa7cc645e05aab376ce571ded))
