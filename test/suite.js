const assert = require('assert');
const express = require('express');
const got = require('got');

const serveModule = require('..');

describe("test suite", function () {
	this.timeout(10000);
	let server, host;

	before(function (done) {
		const app = express();

		app.get('/modules/*', serveModule('/modules', "test/modules"));
		app.get('/node_modules/*', serveModule('/node_modules'));

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

	it('should not reexport global module', async function () {
		const res = await got(host + '/modules/sideeffect/index.js');
		assert.ok(!res.body.startsWith("const module = {exports: {}};const exports = module.exports;"));
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
