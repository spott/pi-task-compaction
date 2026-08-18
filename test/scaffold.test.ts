import { describe, expect, it } from "vitest";
import taskFrameworkExtension from "../extensions/task-framework.js";

describe("greenfield v2 scaffold", () => {
  it("exports a pi extension entrypoint", () => {
    expect(taskFrameworkExtension).toBeTypeOf("function");
  });
});
