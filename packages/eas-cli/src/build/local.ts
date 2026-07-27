import { Job, Metadata, version } from '@expo/eas-build-job';
import spawnAsync from '@expo/spawn-async';
import { ChildProcess } from 'child_process';
import semver from 'semver';

import { getExpoApiBaseUrl } from '../api';
import Log from '../log';
import { ora } from '../ora';

const PLUGIN_PACKAGE_NAME = 'eas-cli-local-build-plugin';
const PLUGIN_PACKAGE_VERSION = version; // should match version of @expo/eas-build-job

export enum LocalBuildMode {
  /**
   * Local build that users can run on their own machines. Instead
   * of sending build request to EAS Servers it's passing it as an argument
   * to local-build-plugin, that will run the build locally.
   *
   * Triggered when running `eas build --local`.
   */
  LOCAL_BUILD_PLUGIN = 'local-build-plugin',
  /**
   * Type of local build that is not accessible to users directly. When
   * cloud build is triggered by git based integration, we are running
   * in this mode. Instead of sending build request to EAS Servers it's
   * printing it to the stdout as JSON, so EAS Build worker can read it.
   */
  INTERNAL = 'internal',
}

export interface LocalBuildOptions {
  localBuildMode?: LocalBuildMode;
  skipCleanup?: boolean;
  skipNativeBuild?: boolean;
  artifactsDir?: string;
  artifactPath?: string;
  workingdir?: string;
  verbose?: boolean;
}

interface LocalBuildCommand {
  command: string;
  args: string[];
  sensitiveArgs: string[];
}

export async function runLocalBuildAsync(
  job: Job,
  metadata: Metadata,
  options: LocalBuildOptions,
  env: Record<string, string>
): Promise<void> {
  const { command, args, sensitiveArgs } = await getCommandAndArgsAsync(job, metadata);
  let spinner;
  if (!options.verbose) {
    spinner = ora().start(options.skipNativeBuild ? 'Preparing project' : 'Building project');
  }
  let childProcess: ChildProcess | undefined;
  const interruptHandler = (): void => {
    if (childProcess) {
      childProcess.kill();
    }
  };
  process.on('SIGINT', interruptHandler);
  try {
    const mergedEnv = {
      ...env,
      ...process.env,
      EAS_LOCAL_BUILD_WORKINGDIR: options.workingdir ?? process.env.EAS_LOCAL_BUILD_WORKINGDIR,
      __API_SERVER_URL: getExpoApiBaseUrl(),
      ...(options.skipCleanup || options.skipNativeBuild
        ? { EAS_LOCAL_BUILD_SKIP_CLEANUP: '1' }
        : {}),
      ...(options.skipNativeBuild ? { EAS_LOCAL_BUILD_SKIP_NATIVE_BUILD: '1' } : {}),
      ...(options.artifactsDir ? { EAS_LOCAL_BUILD_ARTIFACTS_DIR: options.artifactsDir } : {}),
      ...(options.artifactPath ? { EAS_LOCAL_BUILD_ARTIFACT_PATH: options.artifactPath } : {}),
    };
    // log command execution to assist in debugging local builds
    Log.debug('Running local build, using local-build-plugin', {
      command,
      args: redactSensitiveArgs(args, sensitiveArgs),
      env: mergedEnv,
    });
    const spawnPromise = spawnAsync(command, args, {
      stdio: options.verbose ? 'inherit' : 'pipe',
      env: mergedEnv,
    });
    childProcess = spawnPromise.child;
    try {
      await spawnPromise;
    } catch (err) {
      throw redactSensitiveArgsFromError(err, sensitiveArgs);
    }
  } finally {
    process.removeListener('SIGINT', interruptHandler);
    spinner?.stop();
  }
}

async function getCommandAndArgsAsync(
  job: Job,
  metadata: Metadata
): Promise<LocalBuildCommand> {
  const jobAndMetadataBase64 = Buffer.from(JSON.stringify({ job, metadata })).toString('base64');
  if (process.env.EAS_LOCAL_BUILD_PLUGIN_PATH) {
    return {
      command: process.env.EAS_LOCAL_BUILD_PLUGIN_PATH,
      args: [jobAndMetadataBase64],
      sensitiveArgs: [jobAndMetadataBase64],
    };
  } else {
    const args = [`${PLUGIN_PACKAGE_NAME}@${PLUGIN_PACKAGE_VERSION}`, jobAndMetadataBase64];
    if (await isAtLeastNpm7Async()) {
      // npx shipped with npm >= 7.0.0 requires the "-y" flag to run commands without
      // prompting the user to install a package that is used for the first time
      args.unshift('-y');
    }
    return {
      command: 'npx',
      args,
      sensitiveArgs: [jobAndMetadataBase64],
    };
  }
}

async function isAtLeastNpm7Async(): Promise<boolean> {
  const version = (await spawnAsync('npm', ['--version'])).stdout.trim();
  return semver.gte(version, '7.0.0');
}

function redactSensitiveArgs<T>(value: T, sensitiveArgs: string[]): T {
  if (typeof value === 'string') {
    return sensitiveArgs.reduce(
      (result, sensitiveArg) => result.replaceAll(sensitiveArg, '<redacted>'),
      value
    ) as T;
  } else if (Array.isArray(value)) {
    return value.map(item => redactSensitiveArgs(item, sensitiveArgs)) as T;
  }
  return value;
}

function redactSensitiveArgsFromError(err: unknown, sensitiveArgs: string[]): unknown {
  if (err instanceof Error) {
    err.message = redactSensitiveArgs(err.message, sensitiveArgs);
    err.stack = redactSensitiveArgs(err.stack, sensitiveArgs);
  }
  if (typeof err === 'object' && err !== null) {
    const spawnError = err as {
      output?: string[];
      stdout?: string;
      stderr?: string;
    };
    spawnError.output = redactSensitiveArgs(spawnError.output, sensitiveArgs);
    spawnError.stdout = redactSensitiveArgs(spawnError.stdout, sensitiveArgs);
    spawnError.stderr = redactSensitiveArgs(spawnError.stderr, sensitiveArgs);
  }
  return err;
}
