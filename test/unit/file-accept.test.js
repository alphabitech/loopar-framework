import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptsFile } from "../../packages/loopar/core/global/file-accept.js";

const file = (originalname, mimetype) => ({ originalname, mimetype });

test("an empty accept list takes any file", () => {
  assert.equal(acceptsFile("", file("a.exe", "application/octet-stream")), true);
  assert.equal(acceptsFile("/*", file("a.exe", "application/octet-stream")), true);
});

test("extensions, MIME families and exact types", () => {
  const resume = ".pdf,.doc,.docx";
  assert.equal(acceptsFile(resume, file("CV.PDF", "application/pdf")), true);
  assert.equal(acceptsFile(resume, file("cv.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")), true);
  assert.equal(acceptsFile(resume, file("evil.html", "text/html")), false);
  assert.equal(acceptsFile(resume, file("evil.pdf.html", "text/html")), false);
  assert.equal(acceptsFile("image/*", file("p.png", "image/png")), true);
  assert.equal(acceptsFile("image/*", file("p.svg.txt", "text/plain")), false);
  assert.equal(acceptsFile("application/pdf", file("x.bin", "application/pdf")), true);
});
