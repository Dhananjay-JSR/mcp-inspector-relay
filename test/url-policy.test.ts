import { describe, expect, it } from "vitest";
import { UpstreamError, parseUpstreamUrl } from "../src/url-policy";

describe("parseUpstreamUrl", () => {
  it("accepts a public HTTPS upstream", () => {
    const url = parseUpstreamUrl("https://mcp.example.com/sse");
    expect(url.href).toBe("https://mcp.example.com/sse");
  });

  it("drops fragments", () => {
    const url = parseUpstreamUrl("https://mcp.example.com/sse#fragment");
    expect(url.hash).toBe("");
  });

  it("rejects a public HTTP upstream", () => {
    expect(() => parseUpstreamUrl("http://mcp.example.com/sse")).toThrow(UpstreamError);
  });

  it("rejects credentials in the URL", () => {
    expect(() => parseUpstreamUrl("https://user:pass@mcp.example.com/sse")).toThrow(UpstreamError);
  });

  it("rejects localhost by default", () => {
    expect(() => parseUpstreamUrl("https://localhost/sse")).toThrow(UpstreamError);
    expect(() => parseUpstreamUrl("http://localhost:3000/sse")).toThrow(UpstreamError);
  });

  it("allows loopback when explicitly enabled", () => {
    const env = { ALLOW_INSECURE_UPSTREAM: "true" };
    expect(parseUpstreamUrl("http://localhost:3000/sse", env).port).toBe("3000");
    expect(parseUpstreamUrl("http://127.0.0.1:3000/sse", env).hostname).toBe("127.0.0.1");
  });

  it("rejects private IPv4 hosts", () => {
    for (const host of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
    ]) {
      expect(() => parseUpstreamUrl(`https://${host}/sse`)).toThrow(UpstreamError);
    }
  });

  it("rejects reserved IPv4 ranges", () => {
    for (const host of ["192.0.0.1", "192.88.99.1", "240.0.0.1", "255.255.255.255"]) {
      expect(() => parseUpstreamUrl(`https://${host}/sse`)).toThrow(UpstreamError);
    }
  });

  it("rejects special IPv6 ranges", () => {
    for (const host of [
      "[::]",
      "[::ffff:127.0.0.1]",
      "[64:ff9b::a00:1]",
      "[2001:0:4136::1]",
      "[2002:7f00:1::]",
      "[fc00::1]",
      "[fe80::1]",
      "[ff02::1]",
      "[2001:db8::1]",
    ]) {
      expect(() => parseUpstreamUrl(`https://${host}/sse`)).toThrow(UpstreamError);
    }
  });

  it("rejects private IPv4 hosts", () => {
    for (const host of ["[::1]", "[fc00::1]", "[fe80::1]", "[::ffff:127.0.0.1]"]) {
      expect(() => parseUpstreamUrl(`https://${host}/sse`)).toThrow(UpstreamError);
    }
  });

  it("rejects blocked hostnames and suffixes", () => {
    expect(() => parseUpstreamUrl("https://metadata.google.internal/computeMetadata/v1")).toThrow(
      UpstreamError,
    );
    expect(() => parseUpstreamUrl("https://service.internal/sse")).toThrow(UpstreamError);
    expect(() => parseUpstreamUrl("https://printer.local/sse")).toThrow(UpstreamError);
  });

  it("rejects non-443 ports", () => {
    expect(() => parseUpstreamUrl("https://mcp.example.com:8443/sse")).toThrow(UpstreamError);
  });

  it("enforces the optional upstream allowlist", () => {
    const env = { ALLOWED_UPSTREAM_HOSTS: "mcp.example.com,*.trusted.example.com" };
    expect(parseUpstreamUrl("https://mcp.example.com/sse", env).hostname).toBe("mcp.example.com");
    expect(parseUpstreamUrl("https://api.trusted.example.com/sse", env).hostname).toBe(
      "api.trusted.example.com",
    );
    expect(() => parseUpstreamUrl("https://other.example.com/sse", env)).toThrow(UpstreamError);
    expect(() => parseUpstreamUrl("https://trusted.example.com/sse", env)).toThrow(UpstreamError);
  });
});
