# Rapid Node Logger

A multi-transport async logging library for node.js written on top of [winston](http://github.com/winstonjs/winston).

## Version 2.0

Version 2.0 brings major upgrades including Winston 3.x support and Grafana Loki integration.

### Features
- **Winston 3.x** - Modern logging with composable formats
- **Daily Rotate File** - Automatic log rotation by date
- **Grafana Loki** - Send logs to Loki for centralized logging (optional)
- **Express Middleware** - Automatic API request/response logging
- **Backward Compatible** - Existing code works without changes

## Installation

```bash
git clone https://github.com/rapidbizapps/rapid-node-logger logger
```
Copy the folder to node_modules **(folder name should be 'logger')**

Then install dependencies:
```bash
cd node_modules/logger && npm install
```

## Quick Start

### Basic Setup

**Important:** `init()` must be called before creating any logger instances.

```js
// 1. Initialize the logger FIRST (at application startup)
require('logger').init({
    requestKey: "user",
    loki: { labels: { app: "my-app" } },      // Optional
    datadog: { service: "my-app" },            // Optional
    compressAfterDays: 5                       // Optional
});

// 2. Now you can require modules that create loggers
const myController = require('./controllers/myController');

// 3. Use as Express middleware for API logging
app.use(require('logger').logApis);
```

### Creating a Logger

```js
// In any module (after init() has been called)
const Logger = require('logger');
const logger = new Logger.Logger({ label: "MY_MODULE" });

logger.log('info', 'Hello world!');
logger.info('This is an info message');
logger.error('Something went wrong', { errorCode: 500 });
logger.warn('Warning message');
logger.debug('Debug info');
```

## Usage

### Logging Methods

```js
const Logger = require('logger');
const logger = new Logger.Logger({ label: "CONTROLLER" });

// Basic logging
logger.log('info', 'Hello distributed log files!');
logger.info('Hello again distributed logs');
logger.warn('Warning message');
logger.error('Error occurred');
logger.debug('Debug message');

// With metadata
logger.info('User logged in', { userId: '123', ip: '192.168.1.1' });

// With request object (extracts user info automatically)
logger.log('info', 'Processing request', req);
logger.error(err, req);
```

### Logger Options

```js
const logger = new Logger.Logger({
    label: "MY_LABEL",           // Label for log entries
    level: "debug",              // Minimum log level
    console: {
        silent: true             // Disable console output
    },
    file: {
        dirname: "./custom-logs" // Custom log directory
    }
});
```

### Logging Request and Response

```js
// Initialize with the key that contains user details in req object
app.use(require('logger').init({ requestKey: "user" }));

// This middleware logs all API requests/responses
app.use(require('logger').logApis);
```

The `logApis` middleware automatically logs:
- Request URL, method, body, params, query
- Response status code
- User information (from requestKey)
- Sensitive fields (password, card) are stripped

## Loki Integration

Send logs to Grafana Loki for centralized logging and visualization.

### Configuration via init()

```js
app.use(require('logger').init({
    requestKey: "user",
    loki: {
        host: "http://loki:3100",
        labels: {
            app: "my-app",
            env: "production"
        },
        batching: true,       // Enable batching (default: true)
        interval: 5,          // Batch interval in seconds (default: 5)
        basicAuth: "user:pass" // Optional basic auth
    }
}));
```

### Configuration via Environment Variables

```bash
# Set these environment variables
LOKI_HOST=http://loki:3100
LOKI_APP=my-app
```

```js
// Then just add labels in init()
app.use(require('logger').init({
    requestKey: "user",
    loki: {
        labels: { env: "production" }
    }
}));
```

If `LOKI_HOST` is not set and no host is provided, Loki transport is simply skipped.

### Loki Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| host | string | `LOKI_HOST` env | Loki server URL |
| labels | object | `{}` | Labels attached to all logs |
| batching | boolean | `true` | Enable log batching |
| interval | number | `5` | Batch interval in seconds |
| basicAuth | string | - | Basic auth credentials (user:pass) |

## Datadog Integration

Send logs to Datadog for centralized logging, monitoring, and alerting.

### Configuration via init()

```js
app.use(require('logger').init({
    requestKey: "user",
    datadog: {
        apiKey: "your-datadog-api-key",
        service: "my-app",
        hostname: "my-host",
        ddtags: "env:production,version:1.0.0"
    }
}));
```

### Configuration via Environment Variables

```bash
# Set these environment variables
DD_API_KEY=your-datadog-api-key
DD_SERVICE=my-app
DD_HOSTNAME=my-host
DD_SITE=us  # or 'eu' for EU region
```

```js
// Then just initialize without datadog config - it will use env vars
app.use(require('logger').init({
    requestKey: "user",
    datadog: {}  // Empty object triggers Datadog with env vars
}));
```

If `DD_API_KEY` is not set and no apiKey is provided, Datadog transport is simply skipped.

### Datadog Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| apiKey | string | `DD_API_KEY` env | Datadog API key (required) |
| service | string | `DD_SERVICE` env or 'node-app' | Service name |
| hostname | string | `DD_HOSTNAME` env or OS hostname | Host identifier |
| ddsource | string | 'nodejs' | Source identifier |
| ddtags | string | '' | Additional tags (comma-separated) |
| intakeRegion | string | `DD_SITE` env or 'us' | Datadog region: 'us', 'eu' |

## Log Compression

Automatically gzip old log files to save disk space while keeping recent logs easily accessible for debugging.

### Configuration

```js
app.use(require('logger').init({
    requestKey: "user",
    compressAfterDays: 5  // Gzip logs older than 5 days
}));
```

### How It Works

- Runs automatically on app startup (catches up on any missed compressions)
- Checks daily for files to compress (minimal CPU/memory overhead)
- Uses streaming compression (memory-efficient, handles large files)
- Original `.log` files are replaced with `.log.gz` files
- The scheduler uses `unref()` so it won't prevent Node from exiting

### Notes

- Compressed files (`.log.gz`) cannot be queried with `logger.query()` - keep `compressAfterDays` high enough for your debugging needs
- Compression is skipped if a `.gz` file already exists
- Set to `0` or omit to disable compression

## Querying Logs

```js
const options = {
    logFile: '20170721.log',  // Required - log file name
    rows: 100,                 // Number of rows to fetch
    order: 'desc',            // 'desc' or 'asc'
    from: new Date(),          // Start date
    until: new Date(),         // End date
    query: {                   // Filter with regex or arrays
        "url": "/api/users*",
        "user._id": ["abc123", "def456"]
    },
    fields: ['url', 'status'], // Select specific fields
    filePath: './output.json'  // Write results to file
};

logger.query(options, function (err, results) {
    if (err) throw err;
    console.log(results);
});
```

## API Reference

### Module Exports

```js
const Logger = require('logger');

Logger.Logger      // Logger class
Logger.init()      // Initialization middleware
Logger.logApis     // API logging middleware
```

### Logger Methods

| Method | Description |
|--------|-------------|
| `log(level, message, [meta], [req])` | Log with specified level |
| `info(message, [meta], [req])` | Log at info level |
| `error(message, [meta], [req])` | Log at error level |
| `warn(message, [meta], [req])` | Log at warn level |
| `debug(message, [meta], [req])` | Log at debug level |
| `verbose(message, [meta], [req])` | Log at verbose level |
| `query(options, callback)` | Query log files |

### Log Levels

From highest to lowest priority:
1. `error`
2. `warn`
3. `info`
4. `verbose`
5. `debug`
6. `silly`

---

## Migration Guide: V1 to V2

### Requirements

- **Node.js 14+** is required (for Winston 3.x)

### Breaking Changes

1. **init() Required First** - `Logger.init()` must be called before creating any logger instances
2. **Date Pattern Format** - Log filenames use uppercase format (`YYYYMMDD` instead of `yyyyMMdd`)
3. **stream() Method** - Deprecated, use `query()` instead

### What Stays the Same

These patterns continue to work without any changes:

```js
// Logger instantiation - NO CHANGES NEEDED (but init() must be called first)
const logger = new Logger.Logger({ label: "MY_LABEL" });

// Logging methods - NO CHANGES NEEDED
logger.log('info', 'message');
logger.info('message');
logger.error(err, req);

// Middleware - NO CHANGES NEEDED (unless adding Loki)
app.use(require('logger').init({ requsetKey: "user" }));
app.use(require('logger').logApis);

// Query - NO CHANGES NEEDED
logger.query(options, callback);
```

### Migration Steps

#### Step 1: Update Dependencies

```bash
cd node_modules/logger
git pull origin master
npm install
```

#### Step 2: Update Node.js (if needed)

Ensure you're running Node.js 14 or higher:
```bash
node --version
```

#### Step 3: Add Loki (Optional)

If you want to add Loki logging, update your `init()` call:

```js
// Before
app.use(require('logger').init({ requsetKey: "user" }));

// After (with Loki)
app.use(require('logger').init({
    requsetKey: "user",  // Old spelling still works
    loki: {
        labels: { app: "my-app" }
    }
}));
```

Set the `LOKI_HOST` environment variable:
```bash
export LOKI_HOST=http://loki:3100
```

#### Step 4: Fix requestKey Typo (Optional)

The typo `requsetKey` is still supported but you can optionally fix it:

```js
// Old (still works)
app.use(require('logger').init({ requsetKey: "user" }));

// New (preferred)
app.use(require('logger').init({ requestKey: "user" }));
```

### Dependency Changes

| Package | V1 | V2 |
|---------|----|----|
| winston | ^2.3.1 | ^3.17.0 |
| winston-daily-rotate-file | ^1.4.6 | ^5.0.0 |
| winston-loki | - | ^6.1.3 |
| lodash | ^4.17.4 | ^4.17.21 |
| moment | ^2.18.1 | ^2.30.1 |

---

## Changelog

### Version 2.0.0
- Upgraded to Winston 3.x
- Upgraded winston-daily-rotate-file to 5.x
- Added winston-loki transport for Grafana Loki integration
- Added datadog-winston transport for Datadog integration
- Added `compressAfterDays` option to gzip old log files automatically
- Added support for both `requestKey` and `requsetKey` (backward compatibility)
- **Breaking:** `init()` must now be called before creating logger instances
- Modernized codebase to ES6+
- Added 30-day log retention by default
- Improved error handling and graceful shutdown

### Version 1.x
- Initial release with Winston 2.x
- Console and DailyRotateFile transports
- Express middleware for API logging
- Log querying and streaming

## License

ISC
