/**
 * Web sign-in plugin, node half.
 *
 * Deliberately empty: everything this package does runs in the browser (the
 * `dsh.client` entry). The node face exists so the package's `dsh.bundle`
 * patch can mount the client row in the profile composition.
 */

/** Node plugin body — the browser entry lives in `./client`. */
export function apply(): void {}
