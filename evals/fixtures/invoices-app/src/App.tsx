import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ToastProvider } from './components/ui/toast';
import { InvoicesPage } from './features/invoices/InvoicesPage';
import { CreateInvoiceForm } from './features/invoices/CreateInvoiceForm';
import { InvoiceDetail } from './features/invoices/InvoiceDetail';
import './styles/tokens.css';

export function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/invoices" replace />} />
          <Route path="/invoices" element={<InvoicesPage />} />
          <Route path="/invoices/new" element={<CreateInvoiceForm />} />
          <Route path="/invoices/:id" element={<InvoiceDetail />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
