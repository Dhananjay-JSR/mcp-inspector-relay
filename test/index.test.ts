import { describe, expect, it } from "vitest";
import relay from "../src/index";

describe("relay worker", () => {
  it("answers health checks", async () => {
    const response = await relay.fetch(new Request("https://relay.example/healthz"), {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
