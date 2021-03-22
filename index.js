const path = require('path');
const serveStatic = require('serve-static');
const Resolver = require('resolve-relative-import');
const ModuleServer = require("./moduleserver");

/* ES Modules path resolution for browsers */
/* uses fields in package.json (exports,module,jsnext:main,main) */
/* mount is the base path, and it needs a whitelist of modules names */

module.exports = function(prefix) {
	const node_path = path.join('.', 'node_modules');
	const serveHandler = serveStatic(path.resolve(node_path), {
		index: false,
		redirect: false,
		dotfiles: 'ignore',
		fallthrough: false
	});

	const moduleServer = new ModuleServer({
		root: node_path,
		prefix: prefix.substring(1)
	});

	const resolver = new Resolver({ node_path, prefix });

	return function serveModule(req, res, next) {
		if (!req.path.startsWith(prefix + '/')) {
			return next('route');
		}
		if (req.app.settings.env != "development") {
			throw new HttpError.Unauthorized(prefix + " is only served in development environment");
		}
		const extname = path.extname(req.path);
		if (extname && /^\.m?js$/.test(extname)) {
			try {
				if (!moduleServer.handleRequest(req, res)) res.sendStatus(404);
			} catch (err) {
				next(err);
			}
			return;
		}
		const { redir, url } = resolver.resolve(req.path);

		if (redir) {
			res.redirect(url);
		} else {
			req.url = url;
			serveHandler(req, res, next);
		}
	};
};



