const assert = require('assert');
const express = require('express');
const got = require('got');

const serveModule = require('..');

describe("test suite", function () {
	this.timeout(10000);
	let server, host;

	before(function (done) {
		const app = express();
		app.get('/', (req, res) => {
			res.send('Hello World!');
		});

		app.get('/node_modules/*', serveModule('/node_modules'));
		app.use(express.static('public', { extensions: ['html', 'js', 'css', 'js.map'] }));

		server = app.listen(() => {
			host = `http://localhost:${server.address().port}`;
			done();
		});
	});
	after(function (done) {
		server.close(done);
	});

	it('should redirect module to default browser path', async function () {
		const res = await got(host + '/node_modules/jquery');
		assert.strictEqual(
			res.headers['x-request-url'],
			"/node_modules/jquery/dist/jquery.js"
		);
	});

	it('should reexport module', async function () {
		const res = await got(host + '/node_modules/bytes/index.js');
		assert.ok(
			res.body.startsWith("const module = {exports: {}};const exports = module.exports;")
		);
		assert.ok(
			res.body.endsWith(";export default module.exports")
		);
	});
});
