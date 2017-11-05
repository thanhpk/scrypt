
JS = scrypt.js
MAP = ${JS}.map

.PHONY: build
build: debug/${JS}
	mkdir -p release

	./node_modules/uglify-js/bin/uglifyjs \
		"$<" \
		--output "release/${JS}" \
		--define _RELEASE=1 \
		--enclose \
		--support-ie8 \
		--mangle \
		--compress drop_console \
		--in-source-map "debug/${MAP}" \
		--source-map "release/${MAP}" \
		--source-map-include-sources \
		--source-map-url "sourcemap/${MAP}"

debug/${JS}:
	./node_modules/typescript/bin/tsc --project .


.PHONY: clean
clean:
	rm -rf ./debug
	rm -rf ./release
