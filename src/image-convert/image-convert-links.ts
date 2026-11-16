export type {
	ImageContentAnalysis,
	ImageReferenceApp,
	ImageReferenceBlockReason,
	ImageReferenceContext,
	ImageReferenceRewriteResult,
	ImageReferenceScanResult,
	ImageReferenceSite,
	ImageReferenceSourceFile,
	ImageReferenceSourceKind,
} from './image-reference-types.ts';

export {
	countLiveReferencesInVault,
	findImageReferences,
	findImageReferencesBatch,
	findRawImageReferenceSources,
} from './image-reference-scan.ts';
export { hasRawImageReference } from './image-reference-path.ts';
export {
	analyzeReferenceContent,
	countRemainingReferences,
} from './image-reference-analysis.ts';
export { rewriteImageReferences } from './image-reference-rewrite.ts';
