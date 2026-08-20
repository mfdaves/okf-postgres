"use strict";

const fs = require("node:fs");

class MockCatalogClient {
  constructor(responses) {
    this.responses = responses;
    this.calls = [];
  }

  static fromFile(filePath) {
    return new MockCatalogClient(JSON.parse(fs.readFileSync(filePath, "utf8")));
  }

  async query(config) {
    const text = typeof config === "string" ? config : config.text;
    const values = typeof config === "string" ? [] : config.values || [];
    const match = text.match(/\/\* okf-postgres:([a-z]+) \*\//);
    if (!match) throw new Error("Mock received an unrecognized catalog query.");
    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(this.responses, key)) {
      throw new Error(`Mock has no response for ${key}.`);
    }
    this.calls.push({ key, values });
    return { rows: structuredClone(this.responses[key]) };
  }
}

module.exports = { MockCatalogClient };
