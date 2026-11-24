import { Link } from "react-router-dom";
import { EmptyState } from "../components/Feedback";
import { buttonClass } from "../components/ui/Button";

export function NotFoundPage() {
  return (
    <div className="not-found">
      <EmptyState title="Такой страницы нет" page>
        <p>Проверьте адрес или вернитесь к работе: на главную или к документам базы знаний.</p>
        <div className="button-row">
          <Link to="/" className={buttonClass("secondary")}>
            На главную
          </Link>
          <Link to="/documents" className={buttonClass("quiet")}>
            К документам
          </Link>
        </div>
      </EmptyState>
    </div>
  );
}
