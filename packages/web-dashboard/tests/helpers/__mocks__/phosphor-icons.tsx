// Mock for @phosphor-icons/react in tests
// Auto-generates a simple SVG component for any Phosphor icon name

import React from "react";

type IconProps = { size?: number; weight?: string; "aria-label"?: string };

function makeIcon(_name: string) {
  return function MockIcon({ size = 18, ...rest }: IconProps) {
    return React.createElement("svg", { width: size, height: size, ...rest });
  };
}

// Use a Proxy to auto-generate any icon name
export const handler: ProxyHandler<object> = {
  get(_target: unknown, prop: string) {
    if (typeof prop === "string" && prop[0] === prop[0].toUpperCase()) {
      return makeIcon(prop);
    }
    return undefined;
  },
};

module.exports = new Proxy({}, handler);
