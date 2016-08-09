import {
  CodeInspectionReport, CodeInspectionResult
} from '../../node_modules/brackets-inspection-gutters/src/main.d.ts';
import { ESLintOptions } from './eslint.d.ts';

const PackageJson = require('../../package.json');
const EXTENSION_NAME = PackageJson.name;
const fs = require('fs');
const path = require('path');
const nodeVersion = process.versions.node;
const isOldNode = /^0/.test(nodeVersion);
const defaultCwd = process.cwd();
const ESLINT_SEVERITY_ERROR = 2;
const ESLINT_SEVERITY_WARNING = 1;
const BRACKETS_TYPE_ERROR = 'problem_type_error';
const BRACKETS_TYPE_WARNING = 'problem_type_warning';
const BRACKETS_TYPE_META = 'problem_type_meta';

let cli;
let currentVersion;
let currentProjectRoot = null;
let currentProjectRootHasConfig = false;

const log = {
  info: (...args) => console.log('[' + EXTENSION_NAME + ']', ...args),
  warn: (...args) => console.warn('[' + EXTENSION_NAME + ']', ...args),
  error: (...args) => console.error('[' + EXTENSION_NAME + ']', ...args)
};

function getCli(eslintPath, opts) {
  // log version to console to check if we're using the correct eslint
  // const pkgVersion = require(eslintPath + '/package.json').version;
  // console.log('using ESLint version', pkgVersion, 'from:', eslintPath);
  const CLIEngine = require(eslintPath || 'eslint').CLIEngine;
  return new CLIEngine(opts);
}

function getEslintVersion(eslintPath) {
  return require((eslintPath || 'eslint') + '/package.json').version;
}

export function refreshEslintCli(eslintPath?, opts?) {
  try {
    currentVersion = getEslintVersion(eslintPath);
    // brackets can't work with 3.x right now
    if (isOldNode && /^3/.test(currentVersion)) {
      const notSupportedVersion = currentVersion;
      eslintPath = path.resolve(__dirname, 'node_modules', 'eslint');
      currentVersion = getEslintVersion(eslintPath);
      log.error(
        'Detected eslint version 3.x (' + notSupportedVersion +
        '), falling back to default eslint ' + currentVersion
      );
    }
    cli = getCli(eslintPath, opts);
  } catch (err) {
    log.error(err);
  }
}

function uniq(arr) {
  return arr.reduce(function (result, item) {
    if (result.indexOf(item) === -1) {
      result.push(item);
    }
    return result;
  }, []);
}

function normalizeDir(dirPath) {
  if (dirPath.match(/(\\|\/)$/)) {
    dirPath = dirPath.slice(0, -1);
  }
  const dir = process.platform === 'win32' ? dirPath.replace(/\//g, '\\') : dirPath;
  return path.resolve(dir, 'node_modules');
}

export function setProjectRoot(projectRoot?, prevProjectRoot?) {
  // refresh when called without arguments
  if (!projectRoot) { projectRoot = currentProjectRoot; }

  const opts: ESLintOptions = {};
  let eslintPath;
  let rulesDirPath;
  let ignorePath;

  if (projectRoot) {
    // this is critical for correct .eslintrc resolution
    opts.cwd = projectRoot;

    try {
      currentProjectRootHasConfig = fs.readdirSync(projectRoot).some(function (file) {
        return /^\.eslintrc($|\.[a-z]+$)/i.test(file);
      });
    } catch (err) {
      log.warn(`Failed to read contents of ${projectRoot}: ${err}`);
      currentProjectRootHasConfig = false;
    }

    eslintPath = projectRoot + 'node_modules/eslint';
    try {
      if (fs.statSync(eslintPath).isDirectory()) {
        // no action required
      } else {
        throw new Error('not found');
      }
    } catch (ignoreErr) {
      eslintPath = null;
    }

    rulesDirPath = projectRoot + '.eslintrules';
    try {
      if (fs.statSync(rulesDirPath).isDirectory()) {
        opts.rulePaths = [rulesDirPath];
      }
    } catch (ignoreErr) {
      // no action required
    }

    ignorePath = projectRoot + '.eslintignore';
    try {
      if (fs.statSync(ignorePath).isFile()) {
        opts.ignore = true;
        opts.ignorePath = ignorePath;
      }
    } catch (ignoreErr) {
      // no action required
    }
  }

  // make sure plugins are loadable from current project directory
  let nodePaths = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [];
  let io;
  if (prevProjectRoot) {
    // remove from NODE_PATH
    prevProjectRoot = normalizeDir(prevProjectRoot);
    io = nodePaths.indexOf(prevProjectRoot);
    if (io !== -1) {
      nodePaths.splice(io, 1);
    }
  }
  if (projectRoot) {
    // add to NODE_PATH
    projectRoot = normalizeDir(projectRoot);
    nodePaths = [projectRoot].concat(nodePaths);
    process.chdir(projectRoot);
  } else {
    process.chdir(defaultCwd);
  }
  nodePaths = uniq(nodePaths);
  process.env.NODE_PATH = nodePaths.join(path.delimiter);
  require('module').Module._initPaths();

  // console.log('ESLint NODE_PATH', process.env.NODE_PATH);
  refreshEslintCli(eslintPath, opts);
}

function mapEslintMessage(result, version): CodeInspectionResult {
  const offset = version < 1 ? 0 : 1;

  let message;
  let type;
  switch (result.severity) {
    case ESLINT_SEVERITY_ERROR:
      message = 'ERROR: ';
      type = BRACKETS_TYPE_ERROR;
      break;
    case ESLINT_SEVERITY_WARNING:
      message = 'WARNING: ';
      type = BRACKETS_TYPE_WARNING;
      break;
    default:
      message = 'UNKNOWN: ';
      type = BRACKETS_TYPE_META;
  }

  message += result.message;
  if (result.ruleId) { message += ' [' + result.ruleId + ']'; }

  return {
    type,
    message,
    pos: {
      line: result.line - 1,
      ch: result.column - offset
    }
  };
}

function createCodeInspectionReport(eslintReport): CodeInspectionReport {
  // if version is missing, assume 1
  const version = eslintReport.eslintVersion ? eslintReport.eslintVersion.split('.')[0] : 1;
  return {
    errors: eslintReport.results[0].messages.map(x => mapEslintMessage(x, version))
  };
}

export function lintFile(
  fullPath: string, projectRoot: string, callback: (err?: Error, res?: CodeInspectionReport) => void
) {
  if (projectRoot !== currentProjectRoot) {
    setProjectRoot(projectRoot, currentProjectRoot);
    currentProjectRoot = projectRoot;
  }
  if (/(\.ts|\.tsx)$/.test(fullPath) && !currentProjectRootHasConfig) {
    return callback(null, { errors: [] });
  }
  fs.readFile(fullPath, { encoding: 'utf8' }, function (err: Error, text: string) {
    if (err) {
      return callback(new Error(`Failed to read contents of ${fullPath}: ${err}`));
    }
    const relativePath = fullPath.indexOf(projectRoot) === 0 ? fullPath.substring(projectRoot.length) : fullPath;
    let res;
    try {
      process.chdir(projectRoot);
      res = cli.executeOnText(text, relativePath);
      res.eslintVersion = currentVersion;
    } catch (e) {
      err = e.toString();
    }
    return callback(err, createCodeInspectionReport(res));
  });
}

export function fixFile(code, fullPath, callback) {
  let res;
  let err;
  try {
    cli.options.fix = true;
    res = cli.executeOnText(code, fullPath);
  } catch (e) {
    err = e;
  }
  cli.options.fix = false;
  callback(err, res);
}