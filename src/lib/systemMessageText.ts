/**
 * The system-message localizer lives in `shared/systemMessageText.ts`, so the
 * server can write the same sentences for the operator read APIs and the
 * transcript email. This path keeps every dashboard import working.
 */
export * from '../../shared/systemMessageText';
