import { redirect } from "next/navigation";

/** O envio em massa agora fica dentro da Biblioteca; o endereço antigo continua funcionando. */
export default async function UploadPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  redirect(`/w/${slug}/library?enviar=1`);
}
