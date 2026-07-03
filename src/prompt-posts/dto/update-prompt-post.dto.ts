import { PartialType } from '@nestjs/swagger';
import { CreatePromptPostDto } from './create-prompt-post.dto';

export class UpdatePromptPostDto extends PartialType(CreatePromptPostDto) {}
