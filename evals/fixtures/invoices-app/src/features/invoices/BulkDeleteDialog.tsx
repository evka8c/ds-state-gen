import { Button } from '../../components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from '../../components/ui/dialog';

interface BulkDeleteDialogProps {
  open: boolean;
  count: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function BulkDeleteDialog({ open, count, onOpenChange, onConfirm }: BulkDeleteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTitle>
        Delete {count} invoice{count === 1 ? '' : 's'}?
      </DialogTitle>
      <DialogDescription>This permanently removes the invoices and their attachments. This can't be undone.</DialogDescription>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          Delete
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
