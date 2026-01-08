export interface CollectionItem {
  id: string;
  prompt: string;
  image?: string;
  timestamp: number;
  taskId: string;
  localKey?: string;
  sourceSignature?: string;
}
