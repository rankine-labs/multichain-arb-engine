// Side-effect import: wraps console with the key scrubber as early as
// possible. Imported right after dotenv in shadowMain so every later module
// (and every log line) goes through it.
import 'dotenv/config';
import { installLogSanitizer } from './logSanitizer';
installLogSanitizer();
