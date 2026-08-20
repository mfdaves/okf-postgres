#!/usr/bin/env node
"use strict";

const { main } = require("../src/cli");

main().then((code) => {
  process.exitCode = code;
});
