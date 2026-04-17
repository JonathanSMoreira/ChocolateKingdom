# People Analytics — Power BI | Choco Kingdom

> **Portfolio:** fictional corporate-style HR / people data. **EN + PT** for international applications.

---

## English

Two complementary report pages:

- **Operational — “Workforce by sector”** — Day-to-day: attendance by sector over time, headcount / hires / terminations, split between **unjustified absences** and **medical certificates**, and a detailed employee table for line managers.
- **Strategic — “Global vision of people”** — Executive view: KPI cards (people, customers, employees, countries), **map**, age bands (customers vs employees), gender-split sign-up growth, country table.

**Talking points:** Admin and Tech show **very high attendance**; Operations is **lower** (typical frontline pattern). Merging **absence** and **certificate** into one KPI misleads — Operations shows heavy certificate volume, which reframes the discussion toward **health / occupational context**, not only discipline.

**Stack:** Power Query, dimensional model (dimensions + fact), **DAX** (time intelligence, HR metrics), layout for two audiences (coordinator vs leadership). **SQL Server** for business-rule validation alongside the semantic model.

Screenshots (same files as the root `README.md`):

| Strategic | Operational |
| :---: | :---: |
| ![Strategic](readme/power-bi-strategic-global-vision.png) | ![Operational](readme/power-bi-operational-workforce-by-sector.png) |

---

## Português

Duas páginas de relatório que se complementam:

- **Operacional — “Workforce by sector”** — Dia a dia: presença por setor, quadro (headcount, admissões, desligamentos), **falta** vs **atestado**, tabela por colaborador.
- **Estratégica — “Global vision of people”** — Macro: KPIs, **mapa**, idades (clientes vs funcionários), crescimento de cadastros por género, países.

**Para entrevista:** administrativo/tecnologia com presença **muito alta**; operações **mais baixa**. Misturar **falta** com **atestado** baralha a gestão — em operações o peso dos atestados muda o foco para **saúde / contexto**, não só disciplina.

**Stack:** Power Query, modelo dimensional, **DAX**, UI por persona. **SQL Server** para validar regras de negócio.

As mesmas imagens em `docs/readme/`:

| Estratégica | Operacional |
| :---: | :---: |
| ![Estratégica](readme/power-bi-strategic-global-vision.png) | ![Operacional](readme/power-bi-operational-workforce-by-sector.png) |

---

## SQL — absenteísmo (denominador sem folgas)

Granularidade típica: **um registo por colaborador por dia** (`PontoEletronicoDia` ou equivalente no teu schema).

```sql
-- Padrão simplificado: faltas só em dias que não são folga marcada
SELECT
  SUM(CASE WHEN Falta = 1 THEN 1 ELSE 0 END) * 1.0
    / NULLIF(SUM(CASE WHEN Folga = 0 THEN 1 ELSE 0 END), 0) AS AbsenteeismRate
FROM PontoEletronicoDia;
```

*(Ajusta nomes de tabela/colunas ao teu modelo real.)*
