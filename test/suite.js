const Assert = require('assert');
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
	after(function () {
		server.close();
	});

	it('should get jquery', async function () {
		const res = await got(host + '/node_modules/jquery');
		Assert.strictEqual(
			res.headers['x-request-url'],
			"/node_modules/jquery/dist/jquery.js"
		);
	});
});
