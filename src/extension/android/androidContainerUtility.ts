// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { AdbHelper } from "./adb";

const allowedAppNameRegex = /^[\w.-]+$/;
const appNotApplicationRegex = /not an application/;
const appNotDebuggableRegex = /debuggable/;
const operationNotPermittedRegex = /not permitted/;

// The code is borrowed from https://github.com/facebook/flipper/blob/master/desktop/app/src/utils/androidContainerUtility.tsx,
// https://github.com/facebook/flipper/blob/master/desktop/app/src/utils/androidContainerUtilityInternal.tsx

enum RunAsErrorCode {
    NotAnApp = 1,
    NotDebuggable = 2,
}

class RunAsError extends Error {
    code: RunAsErrorCode;

    constructor(code: RunAsErrorCode, message?: string) {
        super(message);
        this.code = code;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export function push(
    adbHelper: AdbHelper,
    deviceId: string,
    app: string,
    filepath: string,
    contents: string,
): Promise<void> {
    return validateAppName(app).then(validApp =>
        validateFilePath(filepath).then(validFilepath =>
            validateFileContent(contents).then(validContent =>
                _push(adbHelper, deviceId, validApp, validFilepath, validContent),
            ),
        ),
    );
}

export function pull(
    adbHelper: AdbHelper,
    deviceId: string,
    app: string,
    path: string,
): Promise<string> {
    return validateAppName(app).then(validApp =>
        validateFilePath(path).then(validPath => _pull(adbHelper, deviceId, validApp, validPath)),
    );
}

function validateAppName(app: string): Promise<string> {
    if (app.match(allowedAppNameRegex)) {
        return Promise.resolve(app);
    }
    return Promise.reject(new Error(`Disallowed run-as user: ${app}`));
}

function validateFilePath(filePath: string): Promise<string> {
    if (!filePath.match(/[']/)) {
        return Promise.resolve(filePath);
    }
    return Promise.reject(new Error(`Disallowed escaping filepath: ${filePath}`));
}

function validateFileContent(content: string): Promise<string> {
    if (!content.match(/["]/)) {
        return Promise.resolve(content);
    }
    return Promise.reject(new Error(`Disallowed escaping file content: ${content}`));
}

function _push(
    adbHelper: AdbHelper,
    deviceId: string,
    app: string,
    filename: string,
    contents: string,
): Promise<void> {
    const command = `echo \\"${contents}\\" > '${filename}' && chmod 644 '${filename}'`;
    return executeCommandAsApp(adbHelper, deviceId, app, command)
        .then(res => {
            console.log(res);
        })
        .catch(error => {
            if (error instanceof RunAsError) {
                // Fall back to running the command directly. This will work if adb is running as root.
                return executeCommandWithSu(adbHelper, deviceId, app, command)
                    .then(() => undefined)
                    .catch(e => {
                        console.debug(e);
                        throw error;
                    });
            }
            throw error;
        });
}

function _pull(adbHelper: AdbHelper, deviceId: string, app: string, path: string): Promise<string> {
    const command = `cat '${path}'`;
    return executeCommandAsApp(adbHelper, deviceId, app, command).catch(error => {
        if (error instanceof RunAsError) {
            // Fall back to running the command directly. This will work if adb is running as root.
            return executeCommandWithSu(adbHelper, deviceId, app, command).catch(e => {
                // Throw the original error.
                console.debug(e);
                throw error;
            });
        }
        throw error;
    });
}

// Keep this method private since it relies on pre-validated arguments
function executeCommandAsApp(
    adbHelper: AdbHelper,
    deviceId: string,
    app: string,
    command: string,
): Promise<string> {
    return _executeCommandWithRunner(adbHelper, deviceId, app, command, `run-as '${app}'`);
}

function executeCommandWithSu(
    adbHelper: AdbHelper,
    deviceId: string,
    app: string,
    command: string,
): Promise<string> {
    return _executeCommandWithRunner(adbHelper, deviceId, app, command, "su");
}

function _executeCommandWithRunner(
    adbHelper: AdbHelper,
    deviceId: string,
    app: string,
    command: string,
    runner: string,
): Promise<string> {
    return adbHelper.executeShellCommand(deviceId, `echo "${command}" | ${runner}`).then(output => {
        if (output.match(appNotApplicationRegex)) {
            throw new RunAsError(
                RunAsErrorCode.NotAnApp,
                `Android package ${app} is not an application. To use it with Flipper, either run adb as root or add an <application> tag to AndroidManifest.xml`,
            );
        }
        if (output.match(appNotDebuggableRegex)) {
            throw new RunAsError(
                RunAsErrorCode.NotDebuggable,
                `Android app ${app} is not debuggable. To use it with Flipper, add android:debuggable="true" to the application section of AndroidManifest.xml`,
            );
        }
        if (output.toLowerCase().match(operationNotPermittedRegex)) {
            throw new Error(
                `Your android device (${deviceId}) does not support the adb shell run-as command. We're tracking this at https://github.com/facebook/flipper/issues/92`,
            );
        }
        return output;
    });
}
