import { test } from "node:test";
import assert from "node:assert/strict";
import { pickWebApp } from "../../packages/loopar/core/global/web-app-pick.js";

const apps = [
  { id: 1, name: "loopar", has_website: 0 },
  { id: 3, name: "shop", has_website: 1 },
  { id: 2, name: "blog", has_website: "1" },
];

test("the app chosen in System Settings wins while it is installed", () => {
  assert.equal(pickWebApp("shop", apps), "shop");
  assert.equal(pickWebApp("loopar", apps), "loopar");
});

test("nothing chosen: the first installed app with a website", () => {
  assert.equal(pickWebApp(null, apps), "blog");
  assert.equal(pickWebApp("", apps), "blog");
});

test("a chosen app that is no longer installed falls back the same way", () => {
  assert.equal(pickWebApp("gone", apps), "blog");
});

test("no app with a website: there is no site", () => {
  assert.equal(pickWebApp(null, [{ id: 1, name: "loopar", has_website: 0 }]), null);
  assert.equal(pickWebApp(null, []), null);
});
