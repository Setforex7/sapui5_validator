module.exports = function (config) {
  config.set({
    frameworks: ['ui5'],
    ui5: {
      url: 'https://sdk.openui5.org',
    },
    browsers: ['ChromeHeadless'],
    reporters: ['progress'],
    singleRun: true,
    files: [
      { pattern: 'webapp/test/unit/**/*.qunit.js', included: false },
      { pattern: 'webapp/test/integration/**/*.qunit.js', included: false },
      { pattern: 'webapp/**/*', included: false, served: true, watched: false },
    ],
  });
};
