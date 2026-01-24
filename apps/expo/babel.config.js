module.exports = function (api) {
  api.cache(true);
  const path = require('path');
  let plugins = [];

  plugins.push('react-native-worklets/plugin');
  plugins.push([
    'module-resolver',
    {
      alias: {
        $convex: path.resolve(__dirname, '../../convex'),
      },
    },
  ]);

  return {
    presets: ['babel-preset-expo'],
    plugins,
  };
};
