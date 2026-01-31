'use strict';

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const LokiTransport = require('winston-loki');
const DatadogTransport = require('datadog-winston');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const interceptor = require('express-interceptor');
const _ = require('lodash');

// Global configuration (set via init())
let initialized = false;
let userKey = "user";
let lokiConfig = null;
let datadogConfig = null;
let compressionTimer = null;
let compressAfterDays = null;

// Ensure logs directory exists
const logsDir = path.resolve(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
	fs.mkdirSync(logsDir, { recursive: true });
}

// Default options for Console transport
const consoleDefaultOptions = {
	format: winston.format.combine(
		winston.format.colorize(),
		winston.format.timestamp(),
		winston.format.printf(({ level, message, timestamp, label, ...meta }) => {
			const labelStr = label ? `[${label}] ` : '';
			const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
			return `${timestamp} ${labelStr}${level}: ${message}${metaStr}`;
		})
	)
};

// Default options for File transport
const fileDefaultOptions = {
	filename: '%DATE%.log',
	datePattern: 'YYYYMMDD',
	dirname: logsDir,
	handleExceptions: true,
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.json()
	),
	maxFiles: '30d'
};

/**
 * Compress a single log file using gzip (streaming, memory-efficient)
 * @param {string} filePath - Path to the log file
 * @returns {Promise}
 */
function compressLogFile(filePath) {
	return new Promise((resolve, reject) => {
		const gzipPath = filePath + '.gz';

		// Skip if already compressed or .gz file exists
		if (fs.existsSync(gzipPath)) {
			return resolve({ skipped: true, file: filePath });
		}

		const readStream = fs.createReadStream(filePath);
		const writeStream = fs.createWriteStream(gzipPath);
		const gzip = zlib.createGzip();

		readStream
			.pipe(gzip)
			.pipe(writeStream)
			.on('finish', () => {
				// Delete original file after successful compression
				fs.unlink(filePath, (err) => {
					if (err) {
						console.error(`Logger: Failed to delete original file ${filePath}:`, err.message);
					}
					resolve({ compressed: true, file: filePath });
				});
			})
			.on('error', (err) => {
				console.error(`Logger: Failed to compress ${filePath}:`, err.message);
				// Clean up partial .gz file on error
				if (fs.existsSync(gzipPath)) {
					fs.unlinkSync(gzipPath);
				}
				reject(err);
			});

		readStream.on('error', (err) => {
			console.error(`Logger: Failed to read ${filePath}:`, err.message);
			reject(err);
		});
	});
}

/**
 * Compress log files older than specified days
 * @param {number} days - Compress files older than this many days
 */
function compressOldLogs(days) {
	if (!days || days < 1) return;

	const now = Date.now();
	const maxAge = days * 24 * 60 * 60 * 1000; // Convert days to milliseconds

	fs.readdir(logsDir, (err, files) => {
		if (err) {
			console.error('Logger: Failed to read logs directory:', err.message);
			return;
		}

		const logFiles = files.filter(f => f.endsWith('.log') && !f.endsWith('.gz'));

		logFiles.forEach(file => {
			const filePath = path.join(logsDir, file);

			fs.stat(filePath, (err, stats) => {
				if (err) return;

				const fileAge = now - stats.mtime.getTime();

				if (fileAge > maxAge) {
					compressLogFile(filePath)
						.then(result => {
							if (result.compressed) {
								console.log(`Logger: Compressed old log file: ${file}`);
							}
						})
						.catch(() => {
							// Error already logged in compressLogFile
						});
				}
			});
		});
	});
}

/**
 * Start the compression scheduler
 * @param {number} days - Compress files older than this many days
 */
function startCompressionScheduler(days) {
	if (compressionTimer) {
		clearInterval(compressionTimer);
	}

	compressAfterDays = days;

	// Run immediately on startup
	compressOldLogs(days);

	// Then run once every 24 hours
	const ONE_DAY_MS = 24 * 60 * 60 * 1000;
	compressionTimer = setInterval(() => {
		compressOldLogs(days);
	}, ONE_DAY_MS);

	// Don't prevent Node from exiting
	if (compressionTimer.unref) {
		compressionTimer.unref();
	}
}

/**
 * Creates Loki transport if configured
 * @param {Object} options - Loki configuration options
 * @param {string} label - Logger label for Loki labels
 * @returns {LokiTransport|null}
 */
function createLokiTransport(options, label) {
	if (!options && !lokiConfig) return null;

	const config = options || lokiConfig;
	const host = config.host || process.env.LOKI_HOST;

	if (!host) return null;

	const lokiOptions = {
		host: host,
		labels: {
			app: config.labels?.app || process.env.LOKI_APP || 'node-app',
			...(config.labels || {}),
			...(label ? { label } : {})
		},
		json: true,
		format: winston.format.json(),
		batching: config.batching !== undefined ? config.batching : true,
		interval: config.interval || 5,
		gracefulShutdown: true,
		clearOnError: false,
		replaceTimestamp: config.replaceTimestamp !== undefined ? config.replaceTimestamp : true,
		onConnectionError: (err) => {
			console.error('Loki connection error:', err);
		}
	};

	// Add basic auth if provided
	if (config.basicAuth) {
		lokiOptions.basicAuth = config.basicAuth;
	}

	return new LokiTransport(lokiOptions);
}

/**
 * Creates Datadog transport if configured
 * @param {Object} options - Datadog configuration options
 * @param {string} label - Logger label for Datadog tags
 * @returns {DatadogTransport|null}
 */
function createDatadogTransport(options, label) {
	if (!options && !datadogConfig) return null;

	const config = options || datadogConfig;
	const apiKey = config.apiKey || process.env.DD_API_KEY;

	if (!apiKey) return null;

	const ddOptions = {
		apiKey: apiKey,
		hostname: config.hostname || process.env.DD_HOSTNAME || require('os').hostname(),
		service: config.service || process.env.DD_SERVICE || 'node-app',
		ddsource: config.ddsource || 'nodejs',
		ddtags: config.ddtags || '',
		intakeRegion: config.intakeRegion || process.env.DD_SITE || 'us'
	};

	// Add label as a tag if provided
	if (label) {
		ddOptions.ddtags = ddOptions.ddtags ? `${ddOptions.ddtags},label:${label}` : `label:${label}`;
	}

	return new DatadogTransport(ddOptions);
}

/**
 * CustomLogger - Winston 3.x based logger with backward compatibility
 * @param {Object} options - Logger options
 * @param {string} options.label - Label for log entries
 * @param {Object} options.console - Console transport options
 * @param {Object} options.file - File transport options
 * @param {Object} options.loki - Loki transport options (optional)
 * @param {Array} options.transports - Custom transports (overrides defaults)
 */
function CustomLogger(options) {
	if (!initialized) {
		throw new Error('Logger.init() must be called before creating logger instances. Ensure init() is called at application startup before requiring modules that use the logger.');
	}

	if (!options) {
		options = {};
	}

	const label = options.label || '';

	// Merge options for console and file
	let consoleOptions = _.cloneDeep(consoleDefaultOptions);
	let fileOptions = _.cloneDeep(fileDefaultOptions);

	// Apply shared options to both transports
	const appliedToBoth = _.clone(options);
	delete appliedToBoth.file;
	delete appliedToBoth.console;
	delete appliedToBoth.loki;
	delete appliedToBoth.transports;
	delete appliedToBoth.label;

	if (!_.isEmpty(appliedToBoth)) {
		_.merge(fileOptions, appliedToBoth);
		_.merge(consoleOptions, appliedToBoth);
	}

	// Merge specific transport options
	if (options.file) {
		_.merge(fileOptions, options.file);
	}
	if (options.console) {
		_.merge(consoleOptions, options.console);
	}

	// Build transports array
	let transports;
	if (options.transports) {
		transports = options.transports;
	} else {
		transports = [
			new winston.transports.Console(consoleOptions),
			new DailyRotateFile(fileOptions)
		];

		// Add Loki transport if configured
		const lokiTransport = createLokiTransport(options.loki, label);
		if (lokiTransport) {
			transports.push(lokiTransport);
		}

		// Add Datadog transport if configured
		const ddTransport = createDatadogTransport(options.datadog, label);
		if (ddTransport) {
			transports.push(ddTransport);
		}
	}

	// Create the winston logger
	const logger = winston.createLogger({
		level: options.level || 'info',
		defaultMeta: label ? { label } : {},
		transports: transports,
		exitOnError: false
	});

	// Store reference to internal logger
	this._logger = logger;
	this.level = options.level || 'info';

	return this;
}

/**
 * Log method with backward compatibility
 * Supports: log(level, message, meta, req) or log(message, req) or log(level, meta, req)
 */
CustomLogger.prototype.log = function () {
	const args = Array.prototype.slice.call(arguments);
	const levels = ['info', 'warn', 'error', 'verbose', 'debug', 'silly'];

	// Default level if not provided
	if (levels.indexOf(args[0]) < 0) {
		args.unshift('info');
	}

	const level = args[0];
	let message = '';
	let meta = {};

	// Check if last argument is a request object
	const lastArg = args[args.length - 1];
	if (lastArg && lastArg.method && lastArg.url) {
		args.pop();
		if (userKey && lastArg[userKey]) {
			meta.user = lastArg[userKey];
		}
	}

	// Process remaining arguments
	for (let i = 1; i < args.length; i++) {
		if (typeof args[i] === 'string') {
			message += (message ? ' ' : '') + args[i];
		} else if (typeof args[i] === 'object' && args[i] !== null) {
			_.merge(meta, args[i]);
		} else if (args[i] !== undefined && args[i] !== null) {
			message += (message ? ' ' : '') + String(args[i]);
		}
	}

	this._logger.log(level, message, meta);
};

/**
 * Info level logging
 */
CustomLogger.prototype.info = function () {
	const args = Array.prototype.slice.call(arguments);
	args.unshift('info');
	this.log.apply(this, args);
};

/**
 * Error level logging
 */
CustomLogger.prototype.error = function () {
	const args = Array.prototype.slice.call(arguments);
	args.unshift('error');
	this.log.apply(this, args);
};

/**
 * Warn level logging
 */
CustomLogger.prototype.warn = function () {
	const args = Array.prototype.slice.call(arguments);
	args.unshift('warn');
	this.log.apply(this, args);
};

/**
 * Debug level logging
 */
CustomLogger.prototype.debug = function () {
	const args = Array.prototype.slice.call(arguments);
	args.unshift('debug');
	this.log.apply(this, args);
};

/**
 * Verbose level logging
 */
CustomLogger.prototype.verbose = function () {
	const args = Array.prototype.slice.call(arguments);
	args.unshift('verbose');
	this.log.apply(this, args);
};

// File logger for API logging
let fileLogger = null;

function getFileLogger() {
	if (!fileLogger) {
		const transports = [new DailyRotateFile(fileDefaultOptions)];

		// Add Loki transport to file logger if configured
		const lokiTransport = createLokiTransport(null, 'API CALL');
		if (lokiTransport) {
			transports.push(lokiTransport);
		}

		// Add Datadog transport to file logger if configured
		const ddTransport = createDatadogTransport(null, 'API CALL');
		if (ddTransport) {
			transports.push(ddTransport);
		}

		fileLogger = winston.createLogger({
			level: 'info',
			defaultMeta: { label: 'API CALL' },
			transports: transports
		});
	}
	return fileLogger;
}

/**
 * Express middleware interceptor for logging API requests/responses
 */
const logInterceptor = interceptor(function (req, res) {
	return {
		isInterceptable: function () {
			return res.get('Content-Type') && /application\/json/.test(res.get('Content-Type'));
		},

		intercept: function (body, send) {
			send(body);
		},

		afterSend: function (oldBody, newBody) {
			if (/application\/json/.test(res.get('Content-Type'))) {
				const reqBody = _.clone(req.body);
				const level = getLevel(res.statusCode);
				const newRec = { url: (req.url.split('?')[0]) };

				if (reqBody) {
					delete reqBody.password;
					delete reqBody.card;
					newRec.body = reqBody;
				}

				if (req[userKey]) {
					newRec.user = _.clone(req[userKey]);
				}

				if (!_.isEmpty(req.params)) {
					newRec.params = req.params;
				}

				if (!_.isEmpty(req.query)) {
					newRec.query = req.query;
				}

				newRec.status = res.statusCode;
				newRec.method = req.method;
				getFileLogger().log(level, `${res.statusCode} ${req.method}`, newRec);
			}
		}
	};
});

/**
 * Get log level based on HTTP status code
 */
function getLevel(status) {
	if (status >= 500) {
		return 'error';
	} else if (status >= 400) {
		return 'warn';
	} else {
		return 'info';
	}
}

/**
 * Query logs from file
 * @param {Object} options - Query options
 * @param {string} options.logFile - Log file name (required)
 * @param {number} options.rows - Number of rows to fetch
 * @param {string} options.order - 'desc' or 'asc'
 * @param {Date} options.from - Start date
 * @param {Date} options.until - End date
 * @param {Object} options.query - Query params with regex
 * @param {string} options.filePath - Output file path
 * @param {Array} options.fields - Selected fields only
 * @param {Function} callback - Callback function
 */
CustomLogger.prototype.query = function (options, callback) {
	if (typeof options === 'function') {
		callback = options;
		options = {};
	}
	if (!options.logFile) {
		return callback(new Error("Please specify the logFile Name"));
	}

	let logFileName = options.logFile.split(".");
	logFileName = logFileName.slice(0, logFileName.length - 1).join('.');

	const file = path.join(logsDir, logFileName + '.log');
	let buff = '';
	let results = [];
	let row = 0;

	const stream = fs.createReadStream(file, {
		encoding: 'utf8'
	});

	let wstream = null;
	if (options.filePath) {
		wstream = fs.createWriteStream(options.filePath, {
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
		if (callback) return callback(err);
	});

	stream.on('data', function (data) {
		const lines = (buff + data).split(/\n+/);
		const l = lines.length - 1;

		for (let i = 0; i < l; i++) {
			if (!options.start || row >= options.start) {
				add(lines[i]);
			}
			row++;
		}

		buff = lines[l];
	});

	stream.on('close', function () {
		if (buff) add(buff, true);
		if (options.order === 'desc') {
			results = results.reverse();
		}
		if (options.filePath && wstream && wstream.writable) {
			wstream.write("]", function () {
				wstream.end();
			});
			if (callback) callback(null, wstream);
		} else {
			if (callback) callback(null, results);
		}
	});

	function add(line, attempt) {
		try {
			const log = JSON.parse(line);
			if (check(log)) push(log);
		} catch (e) {
			if (!attempt) {
				stream.emit('error', e);
			}
		}
	}

	function push(log) {
		if (options.rows && results.length >= options.rows && options.order !== 'desc') {
			if (stream.readable) {
				stream.destroy();
			}
			return;
		}

		if (options.fields) {
			const obj = {};
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
		if (!log || typeof log !== 'object') return false;

		const time = new Date(log.timestamp);

		if (!_.isEmpty(options.query)) {
			let flag = true;
			_.forIn(options.query, function (value, key) {
				if (Array.isArray(value)) {
					flag = checkIfPresent(value, _.get(log, key));
				} else {
					const regex = new RegExp(value);
					if (!regex.test(_.get(log, key))) {
						flag = false;
						return false;
					}
				}
			});

			if (!flag) return false;
		}

		if ((options.from && time < options.from) || (options.until && time > options.until)) {
			return false;
		}

		return true;
	}

	function checkIfPresent(array, value) {
		const present = (_.difference([value], array)).length;
		return present === 0;
	}
};

/**
 * Stream logs (basic implementation)
 */
CustomLogger.prototype.stream = function (options) {
	const EventEmitter = require('events');
	const emitter = new EventEmitter();

	// Basic stream implementation for backward compatibility
	const file = path.join(logsDir, '*.log');
	console.warn('stream() is deprecated in V2. Consider using query() instead.');

	return emitter;
};

module.exports = {
	logApis: logInterceptor,
	Logger: CustomLogger,

	/**
	 * Initialize logger middleware
	 * @param {Object} options - Initialization options
	 * @param {string} options.requestKey - Key in request object containing user details
	 * @param {string} options.requsetKey - (Deprecated) Alias for requestKey (backward compat)
	 * @param {Object} options.loki - Loki transport configuration
	 * @param {string} options.loki.host - Loki server URL (or use LOKI_HOST env var)
	 * @param {Object} options.loki.labels - Labels to attach to logs
	 * @param {boolean} options.loki.batching - Enable batching (default: true)
	 * @param {number} options.loki.interval - Batch interval in seconds (default: 5)
	 * @param {string} options.loki.basicAuth - Basic auth credentials (user:password)
	 * @param {Object} options.datadog - Datadog transport configuration
	 * @param {string} options.datadog.apiKey - Datadog API key (or use DD_API_KEY env var)
	 * @param {string} options.datadog.service - Service name (or use DD_SERVICE env var)
	 * @param {string} options.datadog.hostname - Hostname (or use DD_HOSTNAME env var)
	 * @param {string} options.datadog.ddsource - Source identifier (default: 'nodejs')
	 * @param {string} options.datadog.ddtags - Additional tags (comma-separated)
	 * @param {string} options.datadog.intakeRegion - Datadog region: 'us', 'eu' (or use DD_SITE env var)
	 * @param {number} options.compressAfterDays - Gzip log files older than this many days
	 */
	init: function (options) {
		if (!options) { options = {}; }

		// Mark as initialized
		initialized = true;

		// Support both spellings (backward compatibility)
		userKey = options.requestKey || options.requsetKey;

		if (!userKey) {
			console.error("Logger Init: Please provide the key in request object which has user details. Defaulting to req.user");
			userKey = "user";
		}

		// Configure Loki if provided
		if (options.loki) {
			lokiConfig = options.loki;
			// Reset file logger so it picks up Loki config
			fileLogger = null;
		}

		// Configure Datadog if provided
		if (options.datadog) {
			datadogConfig = options.datadog;
			// Reset file logger so it picks up Datadog config
			fileLogger = null;
		}

		// Start compression scheduler if configured
		if (options.compressAfterDays && options.compressAfterDays > 0) {
			startCompressionScheduler(options.compressAfterDays);
		}

		return function (req, res, next) {
			next();
		};
	}
};
