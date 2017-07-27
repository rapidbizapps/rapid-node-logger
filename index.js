'use strict';

var winston = require('winston');
var fs = require('fs');
var moment = require('moment');
var util = require('util');
var interceptor = require('express-interceptor');
var _ = require('lodash');

var path = require('path');

var userKey = "user";
var options = {
}

if (!fs.existsSync('./logs')) {
	fs.mkdirSync('./logs');
}

var today = moment().utc().format('YYYYMMDD');

var consoleDefaultOptions = {
	colorize: true,
	// timestamp: function () {
	// 	return moment().utc().toDate()
	// },
	// formatter: customFileFormatter
	// silent: true
}

var fileDefaultOptions = {
	filename: './logs/' + today + '.log',
	handleExceptions: true,
	humanReadableUnhandledException: true
};


var CustomLogger = function (options) {

	if (!options) {
		options = {}
	}

	var consoleOptions = {}, fileOptions = {};

	var appliedToBoth = _.clone(options);
	delete appliedToBoth.file;
	delete appliedToBoth.console;

	if (!_.isEmpty(appliedToBoth)) {
		options.file = _.assignIn(options.file, appliedToBoth);
		options.console = _.assignIn(options.console, appliedToBoth);
	}

	fileOptions = _.assignIn(options.file, fileDefaultOptions);

	consoleOptions = _.assignIn(options.console, consoleDefaultOptions);

	if (!options.transports) {
		options.transports = [
			new (winston.transports.Console)(consoleOptions),
			new (winston.transports.File)(fileOptions)
		]
	}
	winston.Logger.call(this, options);
}

util.inherits(CustomLogger, winston.Logger);


var fileLogger = new (winston.Logger)({
	transports: [
		new (winston.transports.File)(fileDefaultOptions)
	]
});

CustomLogger.prototype.log = function () {
	// body
	var args = Array.prototype.slice.call(arguments);

	if (['info', 'warn', 'error', 'verbose', 'silly'].indexOf(args[0]) < 0) {
		args.unshift('info');
	}

	var req = args[args.length - 1];
	if (req && req.method && req.url) {
		args.pop();
		if (!userKey) {
			console.warn("req does not contain", userKey, "key");
		} else {
			args.push(req[userKey]);
		}
	}
	winston.Logger.prototype.log.apply(this, args)
}


var logInterceptor = interceptor(function (req, res) {
	return {
		// Only json responses will be intercepted
		isInterceptable: function () {
			return res.get('Content-Type') && !/text\/html/.test(res.get('Content-Type'));
			// return /application\/json/.test(res.get('Content-Type'));
		},

		// Intercepts before sending response
		intercept: function (body, send) {
			send(body);
		},

		afterSend: function (oldBody, newBody) {
			if (/application\/json/.test(res.get('Content-Type'))) {
				var reqBody = _.clone(req.body);

				var level = getLevel(res.statusCode);
				var newRec = { url: (req.url.split('?')[0])/* , response: newBody */ };

				if (reqBody) {
					delete reqBody.password;
					delete reqBody.card;
					newRec.body = reqBody;
				}

				if (req[userKey]) {
					var owner = _.clone(req[userKey]);
					newRec.user = owner
				}

				if (!_.isEmpty(req.params)) {
					newRec.params = req.params;
				}

				if (!_.isEmpty(req.query)) {
					newRec.query = req.query;
				}
				fileLogger.log(level, res.statusCode, req.method, newRec);
			}
		}
	}
})

function getLevel(status) {
	if (status >= 500) {
		return 'error';
	} else if (status >= 400) {
		return 'warn';
	} else {
		return 'info';
	}
}

CustomLogger.prototype.query = function (options, callback) {
	if (typeof options === 'function') {
		callback = options;
		options = {};
	}
	if (!options.logFile) {
		return callback(new Error("Please specify the logFile Name"));
	}
	options.logFile = options.logFile.split(".");
	options.logFile = options.logFile.slice(0, options.logFile.length);

	var file = path.join(__dirname + './../../' + '/logs/' + options.logFile + '.log'),
		// options = this.normalizeQuery(options),
		buff = '',
		results = [],
		row = 0;

	var stream = fs.createReadStream(file, {
		encoding: 'utf8'
	});

	if (options.filePath) {
		var wstream = fs.createWriteStream(options.filePath, {
			encoding: 'utf8'
		});
		wstream.on('error', function (err) {
			if (wstream.writable) {
				wstream.destroy();
			}
			if (stream.readable) {
				stream.destroy();
			}
		});
	}


	stream.on('error', function (err) {
		if (stream.readable) {
			stream.destroy();
		}
		if (!callback) return;
		return callback(err);
	});

	stream.on('data', function (data) {
		var data = (buff + data).split(/\n+/),
			l = data.length - 1,
			i = 0;

		for (; i < l; i++) {
			if (!options.start || row >= options.start) {
				add(data[i]);
			}
			row++;
		}

		buff = data[l];
	});

	stream.on('close', function () {
		if (buff) add(buff, true);
		if (options.order === 'desc') {
			results = results.reverse();
		}
		if (options.filePath && wstream.writable) {
			wstream.write("]", function (err) {
				wstream.end();
			});
			if (callback) callback(null, wstream);
		} else {
			if (callback) callback(null, results);
		}
	});

	function add(buff, attempt) {
		try {
			var log = JSON.parse(buff);
			if (check(log)) push(log);
		} catch (e) {
			if (!attempt) {
				stream.emit('error', e);
			}
		}
	}

	function push(log) {
		if (options.rows && results.length >= options.rows
			&& options.order != 'desc') {
			if (stream.readable) {
				stream.destroy();
			}
			return;
		}

		if (options.fields) {
			var obj = {};
			options.fields.forEach(function (key) {
				obj[key] = log[key];
			});
			log = obj;
		}

		if (!options.filePath) {
			if (options.order === 'desc') {
				if (results.length >= options.rows) {
					results.shift();
				}
			}

			results.push(log);
		} else {
			if (results.length === 0) {
				wstream.write("[" + JSON.stringify(log));
			} else {
				wstream.write("," + JSON.stringify(log));
			}
			results.push(0);
		}
	}

	function check(log) {
		if (!log) return;

		if (typeof log !== 'object') return;


		var time = new Date(log.timestamp);

		if (!_.isEmpty(options.query)) {
			var flag = true;
			_.forIn(options.query, function (value, key) {

				if (Array.isArray(value)) {
					flag = checkIfPresent(value, _.get(log, key));
				} else {
					var regex = new RegExp(value);
					if (!regex.test(log[key])) {
						flag = false;
						return false;
					}
				}
			})

			if (!flag) {
				return;
			}
		}

		if ((options.from && time < options.from)
			|| (options.until && time > options.until)) {
			return;
		}

		return true;
	}

	function checkIfPresent(array, value) {
		var present = (_.difference([value], array)).length;
		return present === 0;
	}
};

module.exports = {
	logApis: logInterceptor,
	Logger: CustomLogger,
	init: function (options) {
		if (!options) { options = {} }
		return function (req, res, next) {
			userKey = options.requsetKey;
			if (!userKey) {
				console.error("Logger Init : Please give the key in request object which has user details, Defaulting to req.user");
			}
			next();
		}
	}
};
