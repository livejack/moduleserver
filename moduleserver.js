const Path = require("path");
const fs = require("fs");
const resolve = require("resolve");
const crypto = require("crypto");
const { Parser } = require("acorn");
const MyParser = Parser
	.extend(require('acorn-private-methods'))
	.extend(require('acorn-class-fields'));
const walk = require("acorn-walk");


class Cached {
	constructor(content, mimetype) {
		this.content = content;
		this.headers = {
			"content-type": mimetype + "; charset=utf-8",
			"etag": '"' + hash(content) + '"'
		};
	}
}

class ModuleServer {
	constructor(options) {
		this.root = unwin(options.root);
		this.maxDepth = options.maxDepth == null ? 1 : options.maxDepth;
		this.prefix = options.prefix || "_m";
		this.prefixTest = new RegExp(`^/${this.prefix}/(.*)`);
		if (this.root.charAt(this.root.length - 1) != "/") this.root += "/";
		// Maps from paths (relative to root dir) to cache entries
		this.cache = Object.create(null);
		this.handleRequest = this.handleRequest.bind(this);
	}

	handleRequest(req, res) {
		let url = new URL(req.url, "http://localhost");
		let handle = this.prefixTest.exec(url.pathname);
		if (!handle) return false;

		let send = (status, text, headers) => {
			let hds = {};
			if (!headers || typeof headers == "string") {
				hds["content-type"] = headers || "text/plain";
			} else {
				Object.assign(hds, headers);
			}
			res.writeHead(status, hds);
			res.end(text);
		};

		// Modules paths in URLs represent "up one directory" as "__".
		// Convert them to ".." for filesystem path resolution.
		let path = undash(handle[1]);
		let cached = this.cache[path];
		if (!cached) {
			if (countParentRefs(path) > this.maxDepth) {
				send(403, "Access denied");
				return true;
			}
			let fullPath = unwin(Path.resolve(this.root, path));
			let code;
			try {
				code = fs.readFileSync(fullPath, "utf8");
			} catch {
				send(404, "Not found");
				return true;
			}
			if (/\.map$/.test(fullPath)) {
				cached = this.cache[path] = new Cached(code, "application/json");
			} else {
				let { code: resolvedCode, error } = this.resolveImports(fullPath, code);
				if (error) throw error;
				cached = this.cache[path] = new Cached(resolvedCode, "application/javascript");
			}
			// Drop cache entry when the file changes.
			let watching = fs.watch(fullPath, () => {
				watching.close();
				this.cache[path] = null;
			});
			watching.unref();
		}
		let noneMatch = req.headers["if-none-match"];
		if (noneMatch && noneMatch.indexOf(cached.headers.etag) > -1) {
			send(304, null);
			return true;
		}
		send(200, cached.content, cached.headers);
		return true;
	}

	// Resolve a module path to a relative filepath where
	// the module's file exists.
	resolveModule(basePath, path) {
		let resolved;
		try { resolved = resolveMod(path, basePath); }
		catch (e) { return { error: e.toString() }; }

		// Builtin modules resolve to strings like "fs". Try again with
		// slash which makes it possible to locally install an equivalent.
		if (resolved.indexOf("/") == -1) {
			try { resolved = resolveMod(path + "/", basePath); }
			catch (e) { return { error: e.toString() }; }
		}

		return { path: "/" + this.prefix + "/" + unwin(Path.relative(this.root, resolved)) };
	}

	resolveImports(basePath, code) {
		const patches = [];
		let ast;
		try {
			ast = MyParser.parse(code, { sourceType: "module", ecmaVersion: "latest" });
		} catch (error) {
			return { error: error.toString() };
		}
		let isModule = false;
		let isCommonjs = false;

		const patchSrc = (node) => {
			isModule = true;
			if (!node.source) return;
			let orig = (0, eval)(code.slice(node.source.start, node.source.end));
			let { error, path } = this.resolveModule(Path.dirname(basePath), orig);
			if (error) return { error };
			patches.push({
				from: node.source.start,
				to: node.source.end,
				text: JSON.stringify(dash(path))
			});
		};

		walk.simple(ast, {
			ExportAllDeclaration: () => isModule = true,
			ExportDefaultDeclaration: () => isModule = true,
			ExportNamedDeclaration: patchSrc,
			ImportDeclaration: patchSrc,
			ImportExpression: node => {
				isModule = true;
				if (node.source.type == "Literal") {
					let { error, path } = this.resolveModule(
						Path.dirname(basePath), node.source.value
					);
					if (!error) {
						patches.push({
							from: node.source.start,
							to: node.source.end,
							text: JSON.stringify(dash(path))
						});
					}
				}
			},
			AssignmentExpression: node => {
				const names = getAssignmentNames(node.left);
				if (names[0] == "module" && names[1] == "exports" || names[0] == "exports") {
					isCommonjs = true;
				}
			},
			VariableDeclaration: node => {
				if (!node.declarations) return;
				let reqs = [];
				let noreqs = 0;
				for (let decl of node.declarations) {
					if (!decl.init || decl.init.type != "CallExpression" || !decl.init.callee || decl.init.callee.name != "require") {
						noreqs++;
						continue;
					}
					const args = decl.init.arguments[0];
					if (!args) {
						continue; // ? anyway we don't wan't to crash on this ?
					}
					const { error, path } = this.resolveModule(
						Path.dirname(basePath),
						args.value
					);
					if (error) return { error };
					const str = `import ${decl.id.name} from ${JSON.stringify(dash(path))};`;
					reqs.push(str);
				}
				if (reqs.length == 0) return;
				if (noreqs > 0) {
					return {
						error: "moduleserver does not support yet rewriting mixed variable/require declarations"
					};
				}
				patches.push({
					from: node.start,
					to: node.end,
					text: ""
				});
				reqs.forEach(req => patches.push({
					from: node.start,
					to: node.start,
					text: req
				}));
			}
		}, {
			...walk.base,
			FieldDefinition: () => { }
		});
		if (!isModule && isCommonjs) {
			patches.push({
				from: ast.start,
				to: ast.start,
				text: 'const module = {exports: {}};const exports = module.exports'
					+ (code.charAt(ast.start) == ";" ? "" : ";")
			});
			patches.push({
				from: ast.end,
				to: ast.end,
				text: (code.charAt(ast.end - 1) == ";" ? "" : ";")
					+ 'export default module.exports'
			});
		}
		for (let patch of patches.sort((a, b) => b.from - a.from)) {
			code = code.slice(0, patch.from) + patch.text + code.slice(patch.to);
		}
		return { code };
	}
}
module.exports = ModuleServer;

function dash(path) { return path.replace(/(^|\/)\.\.(?=$|\/)/g, "$1__"); }
function undash(path) { return path.replace(/(^|\/)__(?=$|\/)/g, "$1.."); }

const unwin = Path.sep == "\\" ? s => s.replace(/\\/g, "/") : s => s;

function packageFilter(pkg) {
	if (pkg.module) pkg.main = pkg.module;
	else if (pkg.jnext) pkg.main = pkg.jsnext;
	return pkg;
}

function resolveMod(path, base) {
	return resolve.sync(path, { basedir: base, packageFilter });
}

function hash(str) {
	let sum = crypto.createHash("sha1");
	sum.update(str);
	return sum.digest("hex");
}

function countParentRefs(path) {
	let re = /(^|\/)\.\.(?=\/|$)/g, count = 0;
	while (re.exec(path)) count++;
	return count;
}

function getAssignmentNames(left, names = []) {
	if (left.type == "Identifier") {
		names.push(left.name);
	} else if (left.type == "MemberExpression") {
		getAssignmentNames(left.object, names);
		if (left.property && left.property.type == "Identifier" && left.property.name) {
			names.push(left.property.name);
		}
	}
	return names;
}
