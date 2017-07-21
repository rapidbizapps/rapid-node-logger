# Rapid Node Logger

A multi-transport async logging library for node.js written on top of [winston](http://github.com/winstonjs/winston). 


## Installation

```
    git clone https://github.com/rapidbizapps/rapid-node-logger logger
```
Copy the above folder in node_modules (Remeber the folder name should be 'logger')


## Usage


* [Logging](#logging)
  * [Using the Default Logger](#using-the-default-logger)
  * [Logging Request and Response](#logging-request-and-response)
* [Querying Logs](#querying-logs)
* [Streaming Logs](#streaming-logs)
* [Installation](#installation)


## Logging
You have to initialise the logger with some properties

```js
app.use(require('logger').init({ requsetKey: "owner" }));
// requestKey is the key name in request object which has user details [req.owner]
```

### Using the Default Logger
The default logger is accessible through the winston module directly. Any method that you could call on an instance of a logger is available on the default logger:

``` js
    var Logger = require('logger');
    var logger = new Logger.Logger();

    logger.log('info', 'Hello distributed log files!');
    logger.info('Hello again distributed logs');

    logger.level = 'debug';
    logger.log('debug', 'Now my debug messages are written to console!');

    // Attaching req object as last attribute will log even the 'requsetKey' attr from request object to the log record
    logger.log('debug', 'Now my debug messages are written to console!',req);
    logger.log('debug', {someLog : 'test'},req);
    logger.log({someLog : 'test'},req);
    
```

By default, only the Console transport and File transport is set on the default logger with the default options. You can add or remove attributes for both this transport by giving in constructor:

``` js
    var Logger = require('logger');
    
    var options = {
        console : {
            //console transport options
            silent : true // this is disable logs from prinitng in console 
        },
        file : {
            //file transport options
            filename : './logs/someFile.log'
        }
    }
    var logger = new Logger.Logger();
```


For more documentation about working with each individual transport supported by Winston see the 
* [Console Transports](https://github.com/winstonjs/winston/blob/master/docs/transports.md#console-transport)
* [File Transports](https://github.com/winstonjs/winston/blob/master/docs/transports.md#file-transport)

### Logging Request and Response
```js
//First Specify the requestKey
app.use(require('logger').init({ requsetKey: "owner" }));

//This middleware will log request and response
app.use(require('logger').logApis);

```

### String interpolation
The `log` method provides the same string interpolation methods like [`util.format`][10].

This allows for the following log messages.
``` js
logger.log('info', 'test message %s', 'my string');
// info: test message my string

logger.log('info', 'test message %d', 123);
// info: test message 123

logger.log('info', 'test message %j', {number: 123}, {});
// info: test message {"number":123}
// meta = {}

logger.log('info', 'test message %s, %s', 'first', 'second', {number: 123});
// info: test message first, second
// meta = {number: 123}

logger.log('info', 'test message', 'first', 'second', {number: 123});
// info: test message first second
// meta = {number: 123}

```





## Querying Logs

``` js
    /*
        logFile : log file name (required)
        rows : number of rows to fetch, Number
        order : desc/asc ,
        from : Date
        until : to date,
        query : query params with regex
        filePath : stores a json file in the given path
        fields : Gives only selected fields
    */
 	var options = {
		logFile: '20170721.log',
		 query: {
		 	"url": "/tas*",
		 	"user._id": [undefined, "de1fc70a037bd8601eb2a0a69492abfe"]
		 },
		//filePath: path.join(__dirname + './../../' + '/logs/sb.json')
	};
  
  logger.query(options, function (err, results) {
    if (err) {
      throw err;
    }
    console.log(results);
  });
```

## Streaming Logs
Streaming allows you to stream your logs back from your chosen transport.

``` js
  //
  // Start at the end.
  //
  logger.stream({ start: -1 }).on('log', function(log) {
    console.log(log);
  });
```


## Installation

```
    git clone https://github.com/rapidbizapps/rapid-node-logger logger
```
Copy the above folder in node_modules (Remeber the folder name should be 'logger')
