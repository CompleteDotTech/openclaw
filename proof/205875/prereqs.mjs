// proof/205875/prereqs.mjs: installs the Ubuntu packages the native receipt proof needs
// (list from RoboClaw's runbook). Runs as the first offline lane on the GitHub-hosted runner.
import { execFileSync } from 'node:child_process';
const pkgs = ['at-spi2-core', 'dbus-x11', 'gir1.2-gtk-3.0', 'openbox', 'python3-gi', 'x11-utils', 'xauth', 'xdotool', 'xvfb'];
const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
try {
  execFileSync('sudo', ['apt-get', 'update', '-qq'], { stdio: 'inherit', env });
  execFileSync('sudo', ['apt-get', 'install', '-y', '-qq', ...pkgs], { stdio: 'inherit', env });
  console.log('PASS #205875 prerequisites installed');
} catch {
  console.log('FAIL #205875 prerequisites');
  process.exitCode = 1;
}
