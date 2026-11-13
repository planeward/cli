/**
 * Same cases as Planeward's `community-app-frame-protocol.test.ts`; the
 * `SAFE_PATHS` and `UNSAFE_PATHS` corpora are copied as they are.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APP_PATH_MAX_LENGTH,
  APP_PATH_SEARCH_PARAM,
  communityAppChannelHref,
  isSafeRelativePath,
  resolveAppFrameSrc,
} from "./app-path";

const EXPERIENCE_URL = "https://app.example.com/experience";

/** Each of these must load, exactly as written, on the app's own origin. */
const SAFE_PATHS = [
  "/",
  "/orders/123",
  "/orders/123/",
  "/experience?celebrate=first-post",
  "/experience?o=1",
  "/?",
  "/?a=1&b=2",
  "/a?b?c",
  "/search?q=a+b&tags=x,y;z",
  "/~user/a_b-c.d",
  "/a!$&'()*+,;=:@b",
  "/a?x='b'",
  "/a//b",
  // After the first `/`, a scheme, a host or `//` is only path or query data.
  "/@evil.example",
  "/evil.example:443",
  "/https://evil.example",
  "/javascript:alert(1)",
  "/a?next=/b/c",
  "/a?u=https://evil.example/x",
  "/a?to=//evil.example",
  "/a?b=../c&d=./e&f=..",
  // Percent escapes are never decoded by the URL parser, so they stay inert.
  "/%20x",
  "/a%2Fb",
  "/a%2fb",
  "/%2F/evil.example",
  "/%2F%2Fevil.example",
  "/%5Cevil.example",
  "/%5C%5Cevil.example",
  "/%09/evil.example",
  "/%0A/evil.example",
  "/%00",
  "/%25",
  "/%252e%252e/a",
  // Dots that are not a whole `.` or `..` segment.
  "/.well-known/x",
  "/a/...",
  "/a/.hidden",
  "/a/..b",
  "/a/b..",
  "/%2e%2e%2e",
  "/a.%2e",
  "/v1.2/a..b",
];

/** `[why, values]`: none of these may ever pass. */
const UNSAFE_PATHS: [string, string[]][] = [
  [
    "another host",
    [
      "//evil.example",
      "//evil.example/orders",
      "///evil.example",
      "////evil.example",
      "//@evil.example",
      "//user:pw@evil.example",
      "//localhost:3005",
      "//[::1]/",
    ],
  ],
  [
    "a backslash, which URL parsers read as a slash",
    [
      "/\\evil.example",
      "/\\/evil.example",
      "/\\\\evil.example",
      "\\/evil.example",
      "\\\\evil.example",
      "\\evil.example",
      "/a\\b",
      "/a\\..\\..\\b",
      "/a?b=\\c",
    ],
  ],
  [
    "a scheme or anything not starting with /",
    [
      "",
      "https://evil.example",
      "http://evil.example/a",
      "https:/evil.example",
      "https:evil.example",
      "HTTPS://evil.example",
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "mailto:a@evil.example",
      "blob:https://app.example.com/1",
      "file:///etc/passwd",
      "about:blank",
      "evil.example",
      "orders/123",
      "./orders",
      "../orders",
      ".",
      "..",
      "?a=1",
      "#a",
      "@evil.example",
      "%2Forders",
    ],
  ],
  [
    "tabs, newlines and edge whitespace, which URL parsers strip",
    [
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "/\r\n/evil.example",
      "\t//evil.example",
      "\n//evil.example",
      " //evil.example",
      "\u0000//evil.example",
      "\u001f//evil.example",
      "/\t\\evil.example",
      "ht\ntps://evil.example",
      " /a",
      "/a ",
      "\t/a",
      "/a\t",
      "\n/a",
      "/a\n",
      "/a\r\n",
      "/a\u0000",
    ],
  ],
  [
    "whitespace or a control character",
    [
      "/a b",
      "/a\tb",
      "/a\nb",
      "/a\u0000b",
      "/a\u0001b",
      "/a\u000bb",
      "/a\u000cb",
      "/a\u001bb",
      "/a\u007fb",
      "/a\u0085b",
      "/a b",
      "/a b",
      "/a b",
      "/a​b",
      "/a‮b",
      "/a﻿b",
      "﻿/a",
    ],
  ],
  ["a fragment", ["/a#b", "/#", "/a#", "/a?b#c", "/a#//evil.example"]],
  [
    "non-ASCII",
    [
      "/café",
      "/日本",
      "/😀",
      "/\ud83d",
      "/\ude00",
      // Lookalikes of `/`, `\`, `.` and `:`.
      "/／evil.example",
      "/∕evil.example",
      "/⁄evil.example",
      "/＼evil.example",
      "/．．/a",
      "/。。/a",
      "/․․/a",
      "/a：b",
      "/İ",
    ],
  ],
  [
    "a malformed percent escape",
    [
      "/%",
      "/a%",
      "/a%2",
      "/%zz",
      "/%G0",
      "/%2G",
      "/%-1",
      "/% 20",
      "/%2%46",
      "/%u002F",
      "/a?b=%",
      "/a?b=%x1",
    ],
  ],
  [
    "another character URL parsers escape or reserve",
    ['/a"b', "/a<b>", "/a{b}", "/a|b", "/a^b", "/a`b", "/a[b]"],
  ],
  [
    "a . or .. path segment, which URL parsers remove",
    [
      "/.",
      "/..",
      "/./",
      "/../",
      "/./a",
      "/../a",
      "/a/.",
      "/a/..",
      "/a/./b",
      "/a/../b",
      "/a/../../b",
      "/a/b/../../..",
      "/..//evil.example",
      "/.//evil.example",
      "/a/..//evil.example",
      "/..//evil.example/..",
      "/%2e",
      "/%2E",
      "/%2e%2e",
      "/%2E%2E/a",
      "/.%2e/a",
      "/.%2E/a",
      "/%2e./a",
      "/%2e%2E//evil.example",
      "/a/%2e%2e/b",
      "/a/%2e/b",
      "/..?a=1",
      "/.?",
      "/a/..?b",
      "/a/%2e%2e?b=1",
    ],
  ],
];

/** The origin a URL parser lands on, or `null` when it refuses the input. */
function parsedOrigin(input: string, base: string): string | null {
  try {
    return new URL(input, base).origin;
  } catch {
    return null;
  }
}

describe("isSafeRelativePath", () => {
  it("accepts a path with an optional query", () => {
    for (const path of SAFE_PATHS) {
      assert.equal(isSafeRelativePath(path), true, JSON.stringify(path));
    }
  });

  it("rejects everything else", () => {
    for (const [why, paths] of UNSAFE_PATHS) {
      for (const path of paths) {
        assert.equal(
          isSafeRelativePath(path),
          false,
          `${JSON.stringify(path)} has ${why}`
        );
      }
    }
  });

  it("rejects inputs a URL parser would send to another origin", () => {
    // These are real escapes, not just odd strings: left unchecked, each one
    // resolves away from the app's origin.
    for (const escape of [
      "//evil.example",
      "///evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r\n/evil.example",
      "\t//evil.example",
      " //evil.example",
      "\u0000//evil.example",
      "/\t\\evil.example",
      "https://evil.example",
      "ht\ntps://evil.example",
    ]) {
      assert.equal(
        parsedOrigin(escape, EXPERIENCE_URL),
        "https://evil.example",
        JSON.stringify(escape)
      );
      assert.equal(isSafeRelativePath(escape), false, JSON.stringify(escape));
    }
  });

  it("rejects dot segments that would turn into a // path", () => {
    for (const path of [
      "/..//evil.example",
      "/.//evil.example",
      "/a/..//evil.example",
      "/%2e%2E//evil.example",
    ]) {
      assert.equal(
        new URL(path, EXPERIENCE_URL).pathname,
        "//evil.example",
        JSON.stringify(path)
      );
      assert.equal(isSafeRelativePath(path), false, JSON.stringify(path));
    }
  });

  it("matches to the end of the value, not to the end of a line", () => {
    assert.equal(isSafeRelativePath("/a\n"), false);
    assert.equal(isSafeRelativePath("/a\n//evil.example"), false);
    assert.equal(isSafeRelativePath("//evil.example\n/a"), false);
  });

  it("allows up to the length limit and no more", () => {
    assert.equal(APP_PATH_MAX_LENGTH, 512);

    const atLimit = `/${"a".repeat(APP_PATH_MAX_LENGTH - 1)}`;
    assert.equal(atLimit.length, 512);
    assert.equal(isSafeRelativePath(atLimit), true);
    assert.equal(isSafeRelativePath(`${atLimit}a`), false);
    assert.equal(isSafeRelativePath(`${atLimit}/`), false);

    const escapedAtLimit = `/${"%2F".repeat(170)}a`;
    assert.equal(escapedAtLimit.length, 512);
    assert.equal(isSafeRelativePath(escapedAtLimit), true);
    assert.equal(isSafeRelativePath(`${escapedAtLimit}?`), false);

    assert.equal(isSafeRelativePath(`/${"a".repeat(1_000_000)}`), false);
  });

  it("uses the caller's length limit when one is given", () => {
    assert.equal(isSafeRelativePath("/abc", 4), true);
    assert.equal(isSafeRelativePath("/abcd", 4), false);
    assert.equal(isSafeRelativePath("/", 0), false);
    assert.equal(isSafeRelativePath(`/${"a".repeat(600)}`, 2048), true);
    assert.equal(isSafeRelativePath("//evil.example", 2048), false);
    assert.equal(isSafeRelativePath("/a", Number.NaN), false);
  });

  it("rejects values that are not strings", () => {
    for (const value of [
      null,
      undefined,
      0,
      true,
      {},
      ["/a"],
      ["/a", "/b"],
      { toString: () => "/a" },
      new String("/a"),
    ]) {
      assert.equal(
        isSafeRelativePath(value as unknown as string),
        false,
        String(value)
      );
    }
  });
});

describe("resolveAppFrameSrc", () => {
  it("resolves the path against the app's origin", () => {
    assert.equal(
      resolveAppFrameSrc("https://x.com/experience", "/orders/123"),
      "https://x.com/orders/123"
    );
    assert.equal(
      resolveAppFrameSrc("https://x.com/experience", "/experience?o=1"),
      "https://x.com/experience?o=1"
    );
    assert.equal(
      resolveAppFrameSrc("https://x.com/experience", "/"),
      "https://x.com/"
    );
    assert.equal(
      resolveAppFrameSrc("https://x.com", "/orders/123"),
      "https://x.com/orders/123"
    );
  });

  it("drops the experience URL's own path, query and fragment", () => {
    const experienceUrl =
      "https://x.com/apps/demo/experience?tab=home&ref=1#top";
    assert.equal(
      resolveAppFrameSrc(experienceUrl, "/orders/123"),
      "https://x.com/orders/123"
    );
    assert.equal(
      resolveAppFrameSrc(experienceUrl, "/orders/123?tab=items"),
      "https://x.com/orders/123?tab=items"
    );
    assert.equal(resolveAppFrameSrc(experienceUrl, "/"), "https://x.com/");
  });

  it("keeps the scheme, host and port of a localhost app", () => {
    assert.equal(
      resolveAppFrameSrc("http://localhost:3005/experience", "/orders/123"),
      "http://localhost:3005/orders/123"
    );
    assert.equal(
      resolveAppFrameSrc("http://127.0.0.1:8080/", "/a?b=1"),
      "http://127.0.0.1:8080/a?b=1"
    );
    assert.equal(
      resolveAppFrameSrc("http://[::1]:3000/experience", "/a"),
      "http://[::1]:3000/a"
    );
    assert.equal(
      resolveAppFrameSrc("https://x.com:8443/experience", "/a"),
      "https://x.com:8443/a"
    );
    // A path can't move a localhost app to another port or to a remote host.
    for (const path of ["//localhost:9999/a", "/\\localhost:9999", ":9999/a"]) {
      assert.equal(
        resolveAppFrameSrc("http://localhost:3005/experience", path),
        null,
        path
      );
    }
  });

  it("returns null without a path", () => {
    assert.equal(resolveAppFrameSrc(EXPERIENCE_URL, null), null);
    assert.equal(resolveAppFrameSrc(EXPERIENCE_URL, ""), null);
    assert.equal(
      resolveAppFrameSrc(EXPERIENCE_URL, undefined as unknown as string),
      null
    );
    assert.equal(
      resolveAppFrameSrc(EXPERIENCE_URL, ["/a"] as unknown as string),
      null
    );
  });

  it("returns null for every unsafe path, on any experience URL", () => {
    for (const experienceUrl of [
      EXPERIENCE_URL,
      "https://x.com/apps/demo/experience?tab=home#top",
      "http://localhost:3005/experience",
    ]) {
      for (const [why, paths] of UNSAFE_PATHS) {
        for (const path of paths) {
          assert.equal(
            resolveAppFrameSrc(experienceUrl, path),
            null,
            `${JSON.stringify(path)} has ${why}`
          );
        }
      }
      const overLimit = `/${"a".repeat(APP_PATH_MAX_LENGTH)}`;
      assert.equal(resolveAppFrameSrc(experienceUrl, overLimit), null);
    }
  });

  it("loads every safe path unchanged on the experience URL's origin", () => {
    for (const experienceUrl of [
      EXPERIENCE_URL,
      "https://x.com/apps/demo/experience?tab=home#top",
      "http://localhost:3005/experience",
      "https://x.com:8443",
    ]) {
      const origin = new URL(experienceUrl).origin;
      const atLimit = `/${"a".repeat(APP_PATH_MAX_LENGTH - 1)}`;

      for (const path of [...SAFE_PATHS, atLimit]) {
        const src = resolveAppFrameSrc(experienceUrl, path);
        assert.ok(src, JSON.stringify(path));
        assert.equal(new URL(src).origin, origin, JSON.stringify(path));

        const loaded = new URL(src);
        const [pathname] = path.split("?");
        assert.equal(loaded.pathname, pathname, JSON.stringify(path));
        assert.equal(loaded.hash, "", JSON.stringify(path));
        assert.ok(src.startsWith(`${origin}/`), JSON.stringify(path));
        assert.ok(!src.startsWith(`${origin}//`), JSON.stringify(path));
      }
    }
  });

  it("keeps an encoded slash on the app's origin", () => {
    assert.equal(
      resolveAppFrameSrc("https://x.com/experience", "/%2F/evil.com"),
      "https://x.com/%2F/evil.com"
    );
    assert.equal(
      resolveAppFrameSrc("https://x.com/experience", "/%2F%2Fevil.com"),
      "https://x.com/%2F%2Fevil.com"
    );
    assert.equal(
      resolveAppFrameSrc("https://x.com/experience", "/%5Cevil.com"),
      "https://x.com/%5Cevil.com"
    );
  });

  it("returns null when the experience URL is not an http(s) URL", () => {
    for (const experienceUrl of [
      "",
      "not a url",
      "/experience",
      "//x.com/experience",
      "x.com/experience",
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "blob:https://x.com/0b8a",
      "about:blank",
      "ftp://x.com/experience",
      "ws://x.com/experience",
    ]) {
      assert.equal(
        resolveAppFrameSrc(experienceUrl, "/orders/123"),
        null,
        experienceUrl
      );
    }
  });

  it("returns null if the URL parser lands on another origin or path", () => {
    // The validator should make this impossible. This pins the second check,
    // so a parser that disagrees with the validator still can't move the frame.
    const RealURL = globalThis.URL;
    const resolveWithParserResult = (href: string) => {
      globalThis.URL = class extends RealURL {
        constructor(input: string | URL, base?: string | URL) {
          super(base === undefined ? input : href);
        }
      };
      try {
        return resolveAppFrameSrc("https://x.com/experience", "/orders/123");
      } finally {
        globalThis.URL = RealURL;
      }
    };

    assert.equal(
      resolveWithParserResult("https://x.com/orders/123"),
      "https://x.com/orders/123"
    );
    for (const href of [
      "https://evil.example/orders/123",
      "http://x.com/orders/123",
      "https://x.com:8443/orders/123",
      "https://x.com.evil.example/orders/123",
      "https://sub.x.com/orders/123",
      "https://x.com@evil.example/orders/123",
      "blob:https://x.com/orders/123",
      "data:text/html,/orders/123",
      "https://x.com//evil.example",
      "https://x.com/orders",
      "https://x.com/",
    ]) {
      assert.equal(resolveWithParserResult(href), null, href);
    }
  });

  it("holds for every short string over an adversarial alphabet", () => {
    const alphabet = [
      "/",
      "\\",
      ".",
      "%",
      "2",
      "e",
      "E",
      "f",
      ":",
      "@",
      "?",
      "#",
      "\t",
      "\n",
      " ",
      "a",
    ];
    const experienceUrls = [
      "https://x.com/experience?tab=1#top",
      "http://localhost:3005/",
    ];
    let accepted = 0;

    const check = (value: string) => {
      const safe = isSafeRelativePath(value);
      accepted += safe ? 1 : 0;

      for (const experienceUrl of experienceUrls) {
        const src = resolveAppFrameSrc(experienceUrl, value);
        if (!safe) {
          if (src !== null) {
            assert.fail(`${JSON.stringify(value)} resolved to ${src}`);
          }
          continue;
        }
        // The validator alone is enough: the parser needs no second opinion.
        const parsed = new URL(value, experienceUrl);
        const [pathname] = value.split("?");
        assert.equal(src, parsed.href, JSON.stringify(value));
        assert.equal(
          parsed.origin,
          new URL(experienceUrl).origin,
          JSON.stringify(value)
        );
        assert.equal(parsed.pathname, pathname, JSON.stringify(value));
        assert.equal(parsed.hash, "", JSON.stringify(value));
        assert.ok(!parsed.pathname.startsWith("//"), JSON.stringify(value));
      }
    };

    const walk = (prefix: string, depth: number) => {
      if (prefix) {
        check(prefix);
      }
      if (depth > 0) {
        for (const char of alphabet) {
          walk(prefix + char, depth - 1);
        }
      }
    };
    walk("", 5);

    assert.ok(accepted > 1000, `only ${accepted} strings were accepted`);
  });
});

describe("communityAppChannelHref", () => {
  const site = "https://community.example.com";

  it("builds the channel link with the app path as a query parameter", () => {
    assert.equal(APP_PATH_SEARCH_PARAM, "appPath");
    assert.equal(
      communityAppChannelHref("ch_1", "/orders/123"),
      "/channels/ch_1?appPath=%2Forders%2F123"
    );
    assert.equal(
      communityAppChannelHref("ch_1", "/"),
      "/channels/ch_1?appPath=%2F"
    );
    assert.equal(
      communityAppChannelHref("ch_1", "/experience?celebrate=first-post"),
      "/channels/ch_1?appPath=%2Fexperience%3Fcelebrate%3Dfirst-post"
    );
  });

  it("keeps the app path apart from the channel and from other parameters", () => {
    const href = communityAppChannelHref(
      "ch_1",
      "/a?message=m1&appPath=/b#c&x=a+b"
    );
    const url = new URL(href, site);

    assert.equal(url.origin, site);
    assert.equal(url.pathname, "/channels/ch_1");
    assert.equal(url.hash, "");
    assert.deepEqual([...url.searchParams.keys()], ["appPath"]);
    assert.equal(
      url.searchParams.get(APP_PATH_SEARCH_PARAM),
      "/a?message=m1&appPath=/b#c&x=a+b"
    );
  });

  it("encodes the channel id as one path segment", () => {
    assert.equal(
      communityAppChannelHref("a/b?c#d e", "/x"),
      "/channels/a%2Fb%3Fc%23d%20e?appPath=%2Fx"
    );
    const url = new URL(communityAppChannelHref("../../admin", "/x"), site);
    assert.equal(url.pathname, "/channels/..%2F..%2Fadmin");
  });

  it("round-trips every safe path through the community site URL", () => {
    for (const path of SAFE_PATHS) {
      const href = communityAppChannelHref("ch_1", path);
      const url = new URL(href, site);

      assert.equal(url.origin, site, JSON.stringify(path));
      assert.equal(url.pathname, "/channels/ch_1", JSON.stringify(path));
      assert.equal(
        url.searchParams.get(APP_PATH_SEARCH_PARAM),
        path,
        JSON.stringify(path)
      );
      // The stored link is itself a safe path on the community site.
      assert.equal(isSafeRelativePath(href, 2048), true, JSON.stringify(path));
      assert.equal(
        resolveAppFrameSrc(
          EXPERIENCE_URL,
          url.searchParams.get(APP_PATH_SEARCH_PARAM)
        ),
        resolveAppFrameSrc(EXPERIENCE_URL, path),
        JSON.stringify(path)
      );
    }
  });
});
