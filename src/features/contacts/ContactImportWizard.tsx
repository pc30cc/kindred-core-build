import { useState, useRef } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Upload, FileText, ChevronRight, ChevronLeft, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { parseCSV, CONTACT_FIELDS } from './utils';
import { useBulkCreateContacts } from '@/hooks/useContacts';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | undefined;
}

type Step = 'upload' | 'map' | 'preview' | 'done';

export function ContactImportWizard({ open, onOpenChange, workspaceId }: Props) {
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ inserted: number; skipped: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bulkCreate = useBulkCreateContacts(workspaceId);

  const reset = () => {
    setStep('upload');
    setFile(null);
    setHeaders([]);
    setRows([]);
    setMapping({});
    setResult(null);
  };

  const handleClose = (val: boolean) => {
    if (!val) reset();
    onOpenChange(val);
  };

  const autoMap = (hdrs: string[]) => {
    const m: Record<string, string> = {};
    hdrs.forEach((h) => {
      const norm = h.toLowerCase().trim().replace(/[\s_-]/g, '');
      if (['name', 'fullname', 'contact'].includes(norm)) m[h] = 'name';
      else if (['email', 'emailaddress', 'mail'].includes(norm)) m[h] = 'email';
      else if (['phone', 'tel', 'telephone', 'mobile'].includes(norm)) m[h] = 'phone';
      else if (['tags', 'tag', 'segments'].includes(norm)) m[h] = 'tags';
      else if (['company', 'org', 'organization'].includes(norm)) m[h] = 'company';
      else if (['notes', 'note', 'comment'].includes(norm)) m[h] = 'notes';
      else m[h] = '__skip__';
    });
    return m;
  };

  const handleFile = async (f: File) => {
    setFile(f);
    const text = await f.text();
    const parsed = parseCSV(text);
    if (!parsed.headers.length) {
      toast({ title: 'Empty file', description: 'No data found', variant: 'destructive' });
      return;
    }
    setHeaders(parsed.headers);
    setRows(parsed.rows);
    setMapping(autoMap(parsed.headers));
    setStep('map');
  };

  const buildContacts = () => {
    const contacts: any[] = [];
    let skipped = 0;
    rows.forEach((row) => {
      const c: any = { metadata: {} };
      headers.forEach((h, i) => {
        const target = mapping[h];
        const val = (row[i] ?? '').trim();
        if (!target || target === '__skip__' || !val) return;
        if (target === 'tags') {
          c.tags = val.split(/[|,]/).map((t) => t.trim()).filter(Boolean);
        } else if (target === 'company') {
          c.metadata = { ...c.metadata, company: val };
        } else {
          c[target] = val;
        }
      });
      if (!c.name && !c.email && !c.phone) {
        skipped++;
        return;
      }
      contacts.push(c);
    });
    return { contacts, skipped };
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const { contacts, skipped } = buildContacts();
      const res = await bulkCreate.mutateAsync(contacts);
      setResult({ inserted: res.inserted, skipped });
      setStep('done');
    } catch (e: any) {
      toast({ title: 'Import failed', description: e?.message, variant: 'destructive' });
    } finally {
      setImporting(false);
    }
  };

  const previewBuild = step === 'preview' ? buildContacts() : null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import Contacts</DialogTitle>
          <DialogDescription>
            Upload a CSV file, map the columns, and import contacts in bulk.
          </DialogDescription>
        </DialogHeader>

        {/* Steps indicator */}
        <div className="flex items-center gap-2 py-2">
          {(['upload', 'map', 'preview', 'done'] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2 flex-1">
              <div className={cn(
                'w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold border-2 shrink-0',
                step === s ? 'bg-primary text-primary-foreground border-primary' :
                  ['upload', 'map', 'preview', 'done'].indexOf(step) > i ? 'bg-success/20 text-success border-success/40' :
                  'bg-muted text-muted-foreground border-border',
              )}>
                {['upload', 'map', 'preview', 'done'].indexOf(step) > i ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
              </div>
              <span className={cn(
                'text-xs font-medium capitalize',
                step === s ? 'text-foreground' : 'text-muted-foreground',
              )}>{s}</span>
              {i < 3 && <div className="flex-1 h-px bg-border" />}
            </div>
          ))}
        </div>

        {step === 'upload' && (
          <div
            className="border-2 border-dashed border-border rounded-lg p-10 text-center hover:border-primary/50 transition-colors cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files[0];
              if (f) handleFile(f);
            }}
          >
            <Upload className="w-12 h-12 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm font-semibold text-foreground">Drop a CSV file here</p>
            <p className="text-xs text-muted-foreground mt-1">or click to browse</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
            <p className="text-[11px] text-muted-foreground mt-4">
              Supported: <code className="text-foreground">name, email, phone, tags, company, notes</code>
            </p>
          </div>
        )}

        {step === 'map' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-secondary/50 p-2.5 rounded-md">
              <FileText className="w-4 h-4" />
              <span className="truncate flex-1">{file?.name}</span>
              <span className="text-xs">{rows.length} rows</span>
            </div>
            <ScrollArea className="max-h-[300px] pr-3">
              <div className="space-y-2">
                {headers.map((h) => (
                  <div key={h} className="grid grid-cols-2 gap-3 items-center">
                    <Label className="text-sm truncate">{h}</Label>
                    <Select value={mapping[h] || '__skip__'} onValueChange={(v) => setMapping((p) => ({ ...p, [h]: v }))}>
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__skip__">— Skip —</SelectItem>
                        {CONTACT_FIELDS.map((f) => (
                          <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}

        {step === 'preview' && previewBuild && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Ready to import:</span>
              <div className="flex gap-3">
                <span className="font-semibold text-success">{previewBuild.contacts.length} valid</span>
                {previewBuild.skipped > 0 && (
                  <span className="font-semibold text-warning">{previewBuild.skipped} skipped</span>
                )}
              </div>
            </div>
            <ScrollArea className="max-h-[300px] border border-border rounded-md">
              <table className="w-full text-xs">
                <thead className="bg-secondary/50 sticky top-0">
                  <tr>
                    <th className="text-start p-2 font-semibold">Name</th>
                    <th className="text-start p-2 font-semibold">Email</th>
                    <th className="text-start p-2 font-semibold">Phone</th>
                    <th className="text-start p-2 font-semibold">Tags</th>
                  </tr>
                </thead>
                <tbody>
                  {previewBuild.contacts.slice(0, 50).map((c, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="p-2">{c.name || '—'}</td>
                      <td className="p-2 text-muted-foreground">{c.email || '—'}</td>
                      <td className="p-2 text-muted-foreground">{c.phone || '—'}</td>
                      <td className="p-2 text-muted-foreground">{(c.tags ?? []).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {previewBuild.contacts.length > 50 && (
                <p className="p-2 text-xs text-center text-muted-foreground">
                  + {previewBuild.contacts.length - 50} more rows
                </p>
              )}
            </ScrollArea>
          </div>
        )}

        {step === 'done' && result && (
          <div className="text-center py-8">
            <div className="w-16 h-16 rounded-full bg-success/15 flex items-center justify-center mx-auto mb-3">
              <CheckCircle2 className="w-8 h-8 text-success" />
            </div>
            <p className="text-base font-semibold text-foreground">Import complete</p>
            <p className="text-sm text-muted-foreground mt-1">
              <strong className="text-success">{result.inserted}</strong> contacts imported
              {result.skipped > 0 && (<>, <strong className="text-warning">{result.skipped}</strong> skipped</>)}
            </p>
          </div>
        )}

        <div className="flex justify-between pt-2">
          {step !== 'upload' && step !== 'done' && (
            <Button variant="outline" onClick={() => setStep(step === 'preview' ? 'map' : 'upload')}>
              <ChevronLeft className="w-4 h-4 me-1" />Back
            </Button>
          )}
          <div className="flex-1" />
          {step === 'map' && (
            <Button onClick={() => setStep('preview')}>
              Preview <ChevronRight className="w-4 h-4 ms-1" />
            </Button>
          )}
          {step === 'preview' && (
            <Button onClick={handleImport} disabled={importing || !previewBuild?.contacts.length}>
              {importing ? <><Loader2 className="w-4 h-4 me-1.5 animate-spin" />Importing...</> : <>Import {previewBuild?.contacts.length} contacts</>}
            </Button>
          )}
          {step === 'done' && (
            <Button onClick={() => handleClose(false)}>Done</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
