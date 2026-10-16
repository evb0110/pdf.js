import { getDocument, type NativeAnnotationAppearance } from "pdfjs-dist";
import { EventBus } from "pdfjs-dist/web/pdf_viewer.mjs";

class MainTest {
  eventBus: EventBus;
  task: ReturnType<typeof getDocument> | undefined;

  constructor(public file: string) {
    this.eventBus = new EventBus();
  }

  loadPdf() {
    this.task = getDocument({ url: "file://" + this.file });
    return this.task.promise;
  }
}

// This is actually never called, as the test only consists in compiling the file.
// The compilation will crawl through all files and make sure that the types are consistent.
const mt = new MainTest("../pdfs/basicapi.pdf");
const appearance: NativeAnnotationAppearance = {
  digest: "a".repeat(64),
  pdf: null,
  annotations: [{ action: "retain", id: "4R" }],
};
mt.loadPdf().then(async doc => {
  const page = await doc.getPage(1);
  page.render({
    canvas: document.createElement("canvas"),
    viewport: page.getViewport({ scale: 1 }),
    nativeAnnotationAppearance: appearance,
  });
  console.log("loaded");
});
