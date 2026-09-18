import { describe, expect, it } from "vitest";
import { isPrivateAddress, UnsafeUrlError, assertSafeRemoteUrl } from "@/core/security/url-guard";

/*
 * Flow: test della guardia SSRF. Le classi di indirizzi private/riservate
 * sono pure e testabili senza rete; i casi con DNS usano solo IP letterali
 * o host locali, così la suite resta offline e deterministica.
 */
describe("isPrivateAddress", () => {
  it("riconosce le range IPv4 private e riservate", () => {
    for (const address of [
      "0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "172.31.255.255",
      "192.168.1.1", "100.64.0.1", "224.0.0.1", "255.255.255.255", "198.51.100.7", "203.0.113.9",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("accetta IPv4 pubbliche", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "11.0.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("riconosce le range IPv6 private e riservate, incluse le IPv4-mapped", () => {
    for (const address of ["::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:192.168.1.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });
});

describe("assertSafeRemoteUrl", () => {
  it("rifiuta protocolli non http(s)", async () => {
    await expect(assertSafeRemoteUrl("file:///etc/passwd")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeRemoteUrl("ftp://esempio.it")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rifiuta localhost e IP letterali privati senza toccare il DNS", async () => {
    await expect(assertSafeRemoteUrl("http://localhost:3000")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeRemoteUrl("http://127.0.0.1:8080")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeRemoteUrl("http://192.168.1.10/admin")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeRemoteUrl("http://[::1]/")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeRemoteUrl("http://169.254.169.254/latest/meta-data")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rifiuta URL malformati", async () => {
    await expect(assertSafeRemoteUrl("non-un-url")).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});
