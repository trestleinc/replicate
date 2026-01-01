const { getDefaultConfig } = require("expo/metro-config");
const { withNativewind } = require("nativewind/metro");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [monorepoRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

config.resolver.extraNodeModules = {
  "@trestleinc/replicate": monorepoRoot,
  "yjs": path.resolve(projectRoot, "node_modules/yjs"),
  "lib0": path.resolve(projectRoot, "node_modules/lib0"),
};

// Force single copies of yjs and lib0 to prevent duplicate import errors
// Redirect lib0/webcrypto to browser version (avoids isomorphic-webcrypto)
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "yjs") {
    return {
      filePath: path.resolve(projectRoot, "node_modules/yjs/dist/yjs.mjs"),
      type: "sourceFile",
    };
  }
  if (moduleName === "lib0/webcrypto") {
    return {
      filePath: path.resolve(projectRoot, "node_modules/lib0/webcrypto.js"),
      type: "sourceFile",
    };
  }
  if (moduleName.startsWith("lib0/") || moduleName === "lib0") {
    const subpath = moduleName === "lib0" ? "index.js" : moduleName.slice(5) + ".js";
    return {
      filePath: path.resolve(projectRoot, "node_modules/lib0", subpath),
      type: "sourceFile",
    };
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativewind(config, { inlineRem: 16 });
