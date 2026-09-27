import { useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { useToast } from '../../components/ui/toast';
import { api, type Invoice } from '../../lib/api';

interface AttachmentUploadProps {
  invoiceId: string;
  onUploaded: (attachment: Invoice['attachments'][number]) => void;
}

export function AttachmentUpload({ invoiceId, onUploaded }: AttachmentUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const { toast } = useToast();

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const attachment = await api.uploadAttachment(invoiceId, file);
      onUploaded(attachment);
      toast({ title: `${file.name} attached` });
    } catch {
      toast({ title: 'Upload failed', variant: 'destructive' });
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  return (
    <div className="flex items-center gap-3">
      <input ref={inputRef} type="file" className="sr-only" id="attachment" onChange={onChange} />
      <Button variant="outline" size="sm" loading={uploading} onClick={() => inputRef.current?.click()}>
        Attach file
      </Button>
      <span className="text-xs text-[hsl(var(--muted-foreground))]">PDF, PNG or JPG, up to 10 MB</span>
    </div>
  );
}
