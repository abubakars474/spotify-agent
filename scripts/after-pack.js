const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function afterPack(context) {
  // Only on macOS
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  if (!fs.existsSync(appPath)) {
    console.log('[afterPack] app not found at', appPath);
    return;
  }

  const entitlements = path.join(
    context.packager.projectDir,
    'build/entitlements.mac.plist'
  );

  console.log('[afterPack] ad-hoc signing', appPath);

  // 1. Sign every Mach-O binary, dylib, framework recursively
  try {
    execSync(
      `find "${appPath}" -type f \\( -name "*.dylib" -o -name "*.so" -o -perm +111 \\) ` +
      `-exec codesign --force --sign - --timestamp=none --options=runtime {} \\; 2>/dev/null || true`,
      { stdio: 'inherit', shell: '/bin/bash' }
    );
  } catch (e) {
    console.log('[afterPack] inner sign pass had non-fatal issues');
  }

  // 2. Final pass on the whole bundle with entitlements
  try {
    execSync(
      `codesign --force --deep --sign - --timestamp=none --options=runtime ` +
      `--entitlements "${entitlements}" "${appPath}"`,
      { stdio: 'inherit' }
    );
    console.log('[afterPack] signing complete');
  } catch (e) {
    console.error('[afterPack] final sign failed:', e.message);
    throw e;
  }

  // 3. Verify
  try {
    execSync(
      `codesign --verify --deep --strict --verbose=2 "${appPath}"`,
      { stdio: 'inherit' }
    );
    console.log('[afterPack] verification passed');
  } catch (e) {
    console.warn('[afterPack] verify reported issues (often OK for ad-hoc)');
  }
};