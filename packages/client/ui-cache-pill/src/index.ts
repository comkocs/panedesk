/**
 * Cache pill plugin, node half. The empty apply exists so the plugin appears
 * in the host cordis.yml; the browser half ships through exports["./client"].
 */

/** Host plugin body: this surface contributes nothing to the host tree. */
export function apply(): void {}
