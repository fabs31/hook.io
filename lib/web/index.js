/*

  web/index.js

  front-facing webserver service for hook.io
  responsible for static assetts, views, and API endpoints

*/

var big = require('big');
// application has a lot of listeners
big.resource.setMaxListeners(999);
process.setMaxListeners(999);
big.mode = "Online";

var config = require('../../config');

if (process.platform === "darwin") {
  config.sslKeyDirectory = __dirname + '/../../ssl/';
  config.chrootDirectory = '/Users/chroot';
  config.redis.host = "0.0.0.0";
  config.couch.host = "0.0.0.0";
  config.workers = [
   { host: "0.0.0.0", port: "10000" },
   { host: "0.0.0.0", port: "10001" },
   { host: "0.0.0.0", port: "10002" },
   { host: "0.0.0.0", port: "10003" },
   { host: "0.0.0.0", port: "10004" }
  ];
}

var request = require("hyperquest");
var rrequest = require('request');
var http = require('resource-http');
var hook = require('../resources/hook');
var metric = require('../resources/metric');
var modules = require('../resources/packages');
var cache = require('../resources/cache');
var user = require('../resources/user');
var billing = require('../resources/billing');
var domain = require('../resources/domain');
var keys = require('../resources/keys');
var events = require('../resources/events');
//var mergeParams = require('../../view/mergeParams');
var checkRoleAccess = require('../server/routeHandlers/checkRoleAccess');
keys.setUser(user);

var bodyParser = require('body-parser');
var colors = require('colors');
var fs = require('fs');
var pool = config.workers;

// var trycatch = require('trycatch');

var server = {};
module['exports'] = server;

var jsonParser = bodyParser.json();

var sslKeyDirectory = config.sslKeyDirectory;

server.start = function start (opts, cb) {

  var GitHubStrategy = require('passport-github').Strategy;

  var key = fs.readFileSync(sslKeyDirectory + "server.key").toString();
  var cert = fs.readFileSync(sslKeyDirectory + "server.crt").toString();
  var ca = [fs.readFileSync(sslKeyDirectory + 'gd1.crt').toString(), fs.readFileSync(sslKeyDirectory + 'gd2.crt').toString(), fs.readFileSync(sslKeyDirectory + 'gd3.crt').toString()]

  // sometimes in development you might mix and match a common ssl for projects
  // comment this line out for production usage
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0

  initCouchDatabase(function(){

    keys.persist(config.couch);
    hook.persist(config.couch);
    user.persist(config.couch);
    billing.persist(config.couch);
    domain.persist(config.couch);

    http.listen({
        enableUploads: false,
        host: config.web.host,
        root: __dirname + '/../../public',
        roots: config.web.roots,
        view: __dirname + '/../../view',
        passport: true,
        port: config.web.port,
        // whiteLabels: ['webhookhosting.com', 'microservicehosting.com', 'stackvana.com'],
        // whiteLabelView: "/Users/a/dev/big/hook.io-white/",
        locales: {
          locales: config.locales.locales,
          directory: require.resolve('hook.io-i18n').replace('index.js', '/locales')
        },
        session: config.web.session,
        redis: config.web.redis,
        cacheView: config.cacheView,
        customDomains: true,
        sslRequired: false // will not force ssl connections on custom domains / subdomains
    }, function (err, app) {

      var GITHUB_CLIENT_ID = config.github.CLIENT_ID;
      var GITHUB_CLIENT_SECRET = config.github.CLIENT_SECRET;

      server.app = app;
      big.server = server;
      var vfs =  require('hook.io-vfs');
      var vfsMiddle = vfs.middle({
        config: config,
        prefix: "/files/api/v1/fs",
        checkRoleAccess: checkRoleAccess,
        parent: app.view,
        unauthorizedRoleAccess: config.messages.unauthorizedRoleAccess
      });

      app.use('/files', vfsMiddle);


      // TODO: move passport / login callback routes to separate file
      var passport = require('passport');

      passport.use(new GitHubStrategy({
          clientID: GITHUB_CLIENT_ID,
          clientSecret: GITHUB_CLIENT_SECRET,
          callbackURL: config.github.OAUTH_CALLBACK
        },
        function(accessToken, refreshToken, profile, done) {
          process.nextTick(function () {
            profile.accessToken = accessToken;
            return done(null, profile);
          });
        }
      ));

      app.get('/login/github', passport.authenticate('github', {
        /*
          Remark: gist scope has been removed by default
                  now use /login/github/gist route for gist role access
        */
      }),
      function(req, res){
          // The request will be redirected to GitHub for authentication, so this
          // function will not be called.
      });

      app.get('/login/github/gist', passport.authenticate('github', {
          scope: ["gist"]
      }),
      function(req, res){
          // The request will be redirected to GitHub for authentication, so this
          // function will not be called.
      });

      var loginCallbackHandler = require('../server/routeHandlers/loginCallback');
      app.get('/login/github/callback',
        passport.authenticate('github', { failureRedirect: '/failed' }),
        function(req, res) {
          loginCallbackHandler(req, res);
        });

      app.get('/logout', function(req, res){
        req.session.user = "anonymous";
        req.session.destroy();
        req.logout();
        res.redirect("/");
      });

      function ensureAuthenticated(req, res, next) {
        if (req.isAuthenticated()) { return next(); }
        res.redirect('/login')
      }

      var hookHandler = require('../server/routeHandlers/hook');

      function hookHandler (req, res) {
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        hookHandler(req, res);
      };

      var handleUser = require('../server/routeHandlers/user');

      app.get('/:owner', function (req, res) {
        req.params.owner = req.params.owner.toLowerCase();
        handleUser(req, res, app);
      });

      app.get('/metrics/hook/:metric', function (req, res){
        metric.get('/hook' + "/" + req.params.metric, function(err, result){
          /*
          res.writeHead(200, {
            "Content-Type": "text/plain"
          });
          */
          if (result === null || typeof result === "undefined") {
            result = "0";
          }
          res.end(result.toString());
        })
      });

      app.get('/metrics/:owner/:hook/:metric', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        metric.get('/' + req.params.owner + "/" + req.params.hook + "/" + req.params.metric, function(err, result){
          res.end(result);
        })
      });

      app.post('/:owner', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        res.end(req.params.owner);
      });

      var handleDelete = require('../server/routeHandlers/hookDelete');
      var handleResource = require('../server/routeHandlers/hookResource');
      var handlePackage = require('../server/routeHandlers/hookPackage');
      var handleSource = require('../server/routeHandlers/hookSource');
      var handleView = require('../server/routeHandlers/hookView');
      var handlePresenter = require('../server/routeHandlers/hookPresenter');
      var handleLogs = require('../server/routeHandlers/hookLogs');
      var handleEvents = require('../server/routeHandlers/hookEvents');
      var handleModules = require('../server/routeHandlers/modules');
      var handleRefresh = require('../server/routeHandlers/refresh');

      app.get("/modules/install", function(req, res){
        handleModules(req, res);
      });

      app.get('/modules/installed', function (req, res){
        modules.all({ status: 'installed' }, function(err, result){
          res.writeHead(200, {
            "Content-Type": "text/plain"
          });
          res.end(JSON.stringify(result, true, 2));
        });
      });

      app.get('/modules/pending', function (req, res){
        modules.all({ status: 'pending' }, function(err, result){
          res.writeHead(200, {
            "Content-Type": "text/plain"
          });
          res.end(JSON.stringify(result, true, 2));
        })
      });

      app.get('/modules/errored', function (req, res){
        modules.all({ status: 'errored' }, function(err, result){
          res.writeHead(200, {
            "Content-Type": "text/plain"
          });
          res.end(JSON.stringify(result, true, 2));
        })
      });

      app.get('/:owner/:hook/refresh', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        return handleRefresh(req, res);
      });

      app.post('/:owner/:hook/refresh', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        return handleRefresh(req, res);
      });

      app.get('/:owner/:hook/admin', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        return res.redirect(config.app.url + '/admin?owner=' + req.params.owner + '&name=' + req.params.hook + '');
      });

      app.get('/:owner/:hook/delete', function (req, res) {
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        return handleDelete(req, res);
      });

      app.post('/:owner/:hook/delete', function (req, res) {
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        return handleDelete(req, res);
      });

      app.get('/:owner/:hook/resource', function (req, res) {
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        return handleResource(req, res);
      });

      app.post('/:owner/:hook/resource', function (req, res) {
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        return handleResource(req, res);
      });

      app.get('/:owner/:hook/package', function (req, res) {
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        return handlePackage(req, res);
      });

      app.post('/:owner/:hook/package', function (req, res) {
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        return handlePackage(req, res);
      });

      app.get('/:owner/:hook/fork', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        return res.redirect(config.app.url + "/" +  req.params.owner + '/' + req.params.hook + '?fork=true');
      });

      app.post('/:owner/:hook/fork', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        return res.redirect(config.app.url + "/" +  req.params.owner + '/' + req.params.hook + '?fork=true');
      });

      app.post('/:owner/:hook/admin', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        return res.redirect(config.app.url + '/admin?owner=' + req.params.owner + '&name=' + req.params.hook + '');
      });

      /* TODO: enable stande-alone editor
      app.get('/:owner/:hook/editor', function (req, res){
        app.view.editor.index.present({ request: req, response: res }, function(err, html){
          console.log(err)
          res.end(html);
        });
      });
      */

      app.get('/:owner/:hook/logs', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        handleLogs(req, res);
      });

      app.post('/:owner/:hook/logs', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        handleLogs(req, res);
      });

      app.get('/:owner/events', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        //req.params.hook = req.params.hook.toLowerCase();
        handleEvents(req, res);
      });

      app.post('/:owner/events', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        //req.params.hook = req.params.hook.toLowerCase();
        handleEvents(req, res);
      });

      app.get('/:owner/:hook/source', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        handleSource(req, res);
      });

      app.post('/:owner/:hook/source', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        handleSource(req, res);
      });

      app.get('/:owner/:hook/view', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        handleView(req, res);
      });

      app.post('/:owner/:hook/view', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        handleView(req, res);
      });

      app.get('/:owner/:hook/presenter', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        handlePresenter(req, res);
      });

      app.post('/:owner/:hook/presenter', function (req, res){
        req.params.owner = req.params.owner.toLowerCase();
        req.params.hook = req.params.hook.toLowerCase();
        handlePresenter(req, res);
      });

      app.use(server.handle404);
      cb(null, app);

    });
  });

};

server.handle404 = function handle404 (req, res) {
  server.app.view['404'].present({
    request: req,
    response: res
  }, function (err, html){
    res.writeHead(404);
    res.end(html);
  })
};


// TODO: this should be part of the resource library
// see: https://github.com/bigcompany/resource/issues/33
function initCouchDatabase (cb) {
  var nano = require('nano')('http://' + config.couch.username + ":" + config.couch.password + "@" + config.couch.host + ':' + config.couch.port);
  //var db = nano.use(config.couch.database);
  nano.db.create(config.couch.database, function (err) {
    if (err) {
      console.log('!!Cannot create couchdb ' + err.message);
    } else {
      console.log('!!Created new couchdb ' + config.couch.database)
    }
    cb(null);
  });
}