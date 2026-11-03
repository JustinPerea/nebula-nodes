/** A file name the way the canvas's labels quote one. Its own module so a
 *  worker can import code that quotes names without the canvas store. */
export const quoted = (name: string) => `“${name}”`;
