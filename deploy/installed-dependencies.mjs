import { readdirSync, readFileSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';

// Bind the complete installed closure, including transitive code and bin links.
// Capture this after trusted npm ci; a package version alone does not bind code.
export function fingerprintDependencies(directory) {
  const root = realpathSync(directory), digest = createHash('sha256');
  let files = 0, links = 0, bytes = 0;
  function visit(dir, relative = '') {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), key = relative ? relative + '/' + name : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        if (!realpathSync(path).startsWith(root + sep)) throw new Error('DEPENDENCY_LINK_ESCAPE');
        digest.update('L\0' + key + '\0' + readlinkSync(path) + '\0'); links++;
      } else if (stat.isDirectory()) {
        digest.update('D\0' + key + '\0'); visit(path, key);
      } else if (stat.isFile()) {
        const data = readFileSync(path);
        digest.update('F\0' + key + '\0' + createHash('sha256').update(data).digest('hex') + '\0');
        files++; bytes += data.length;
      } else throw new Error('UNSUPPORTED_DEPENDENCY_ENTRY');
    }
  }
  visit(root);
  return { algorithm: 'sha256-path-type-content-v1', sha256: digest.digest('hex'), files, links, bytes };
}
