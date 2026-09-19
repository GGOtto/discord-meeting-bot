import assert from "node:assert/strict";
import test from "node:test";
import { commands } from "../src/commands.js";

test("series creation opens a wizard instead of exposing a long option list", () => {
  const series = commands.find((command) => command.name === "series");
  const create = series?.options?.find((option) => option.name === "create");
  assert.ok(create);
  assert.ok("options" in create);
  assert.deepEqual(create.options ?? [], []);
  assert.match(create.description, /wizard/i);
});
